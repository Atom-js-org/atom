'use strict';

function generateBridgeScript({ websocketUrl, preloadCode = '' }) {
  const endpoint = JSON.stringify(websocketUrl);
  const preload = JSON.stringify(preloadCode);

  return `
(() => {
  'use strict';

  const endpoint = ${endpoint};
  const preloadSource = ${preload};
  const channelListeners = new Map();
  const pendingInvocations = new Map();
  const outboundQueue = [];
  let sequence = 0;
  let socket = null;

  function serializeError(error) {
    return {
      name: error && error.name ? String(error.name) : 'Error',
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack) : undefined
    };
  }

  function sendNow(message) {
    const payload = JSON.stringify(message);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    outboundQueue.push(payload);
  }

  function flushQueue() {
    while (outboundQueue.length && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(outboundQueue.shift());
    }
  }

  function makeEvent(channel) {
    return Object.freeze({
      channel,
      senderId: 'main',
      reply(replyChannel, ...args) {
        ipcRenderer.send(replyChannel, ...args);
      }
    });
  }

  function addListener(channel, listener, once) {
    if (typeof listener !== 'function') {
      throw new TypeError('IPC listener must be a function');
    }
    const bucket = channelListeners.get(channel) || new Set();
    const record = { listener, once: Boolean(once) };
    bucket.add(record);
    channelListeners.set(channel, bucket);
    return record;
  }

  function removeListener(channel, listener) {
    const bucket = channelListeners.get(channel);
    if (!bucket) return;
    for (const record of bucket) {
      if (record.listener === listener) bucket.delete(record);
    }
    if (bucket.size === 0) channelListeners.delete(channel);
  }

  function emitChannel(channel, args) {
    const bucket = channelListeners.get(channel);
    if (!bucket) return;
    for (const record of [...bucket]) {
      try {
        record.listener(makeEvent(channel), ...args);
      } catch (error) {
        console.error('[AtomJS renderer IPC listener error]', error);
      }
      if (record.once) bucket.delete(record);
    }
    if (bucket.size === 0) channelListeners.delete(channel);
  }

  const ipcRenderer = Object.freeze({
    send(channel, ...args) {
      sendNow({ type: 'send', channel, args });
    },

    invoke(channel, ...args) {
      const id = 'invoke-' + (++sequence);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingInvocations.delete(id);
          reject(new Error('IPC invocation timed out: ' + channel));
        }, 30000);
        pendingInvocations.set(id, { resolve, reject, timeout });
        sendNow({ type: 'invoke', id, channel, args });
      });
    },

    on(channel, listener) {
      addListener(channel, listener, false);
      return this;
    },

    once(channel, listener) {
      addListener(channel, listener, true);
      return this;
    },

    removeListener(channel, listener) {
      removeListener(channel, listener);
      return this;
    },

    removeAllListeners(channel) {
      if (channel === undefined) channelListeners.clear();
      else channelListeners.delete(channel);
      return this;
    }
  });

  const contextBridge = Object.freeze({
    exposeInMainWorld(key, api) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('contextBridge key must be a non-empty string');
      }
      Object.defineProperty(globalThis, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: api
      });
    }
  });

  const webFrame = Object.freeze({
    getZoomFactor: () => 1,
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
    setZoomLevel: () => {},
    insertCSS: async () => '',
    removeInsertedCSS: async () => {}
  });

  const atomModule = Object.freeze({ ipcRenderer, contextBridge, webFrame });

  function atomRequire(specifier) {
    if (specifier === '@atom-js-org/runtime' || specifier === 'atomjs' || specifier === 'atom' ||
        specifier === 'electron' || specifier === 'electron/renderer' ||
        specifier === 'electron/common') {
      return atomModule;
    }
    throw new Error(
      "AtomJS system-WebView preload supports require('electron') for Electron renderer APIs, " +
      "plus require('@atom-js-org/runtime'), require('atomjs'), and require('atom'). Use ipcRenderer for privileged Node.js work."
    );
  }

  async function handleSystemMessage(message) {
    switch (message.command) {
      case 'close':
        window.close();
        break;
      case 'reload':
        location.reload();
        break;
      case 'navigate':
        location.href = String(message.url);
        break;
      case 'set-title':
        document.title = String(message.title || '');
        break;
      case 'execute': {
        try {
          const result = await (0, eval)(String(message.code));
          sendNow({ type: 'execute-result', id: message.id, ok: true, result });
        } catch (error) {
          sendNow({ type: 'execute-result', id: message.id, ok: false, error: serializeError(error) });
        }
        break;
      }
      default:
        console.warn('[AtomJS] Unknown system command:', message.command);
    }
  }

  function connect() {
    socket = new WebSocket(endpoint);

    socket.addEventListener('open', () => {
      flushQueue();
      sendNow({ type: 'bridge-open' });
    });

    socket.addEventListener('message', async (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        console.error('[AtomJS] Invalid bridge message', error);
        return;
      }

      if (message.type === 'invoke-result') {
        const pending = pendingInvocations.get(message.id);
        if (!pending) return;
        pendingInvocations.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.ok) pending.resolve(message.result);
        else {
          const error = new Error(message.error && message.error.message ? message.error.message : 'IPC invocation failed');
          if (message.error && message.error.stack) error.stack = message.error.stack;
          pending.reject(error);
        }
        return;
      }

      if (message.type === 'event') {
        emitChannel(message.channel, Array.isArray(message.args) ? message.args : []);
        return;
      }

      if (message.type === 'system') {
        await handleSystemMessage(message);
      }
    });

    socket.addEventListener('close', () => {
      for (const pending of pendingInvocations.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('AtomJS bridge disconnected'));
      }
      pendingInvocations.clear();
    });

    socket.addEventListener('error', (event) => {
      console.error('[AtomJS] Renderer bridge error', event);
    });
  }

  connect();

  try {
    const module = { exports: {} };
    const preloadFunction = new Function('require', 'module', 'exports', preloadSource);
    preloadFunction(atomRequire, module, module.exports);
  } catch (error) {
    console.error('[AtomJS preload error]', error);
  }

  function signalReady() {
    sendNow({ type: 'renderer-ready', title: document.title, href: location.href });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', signalReady, { once: true });
  } else {
    queueMicrotask(signalReady);
  }

  Object.defineProperty(globalThis, '__ATOMJS_INTERNAL__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ipcRenderer, contextBridge, webFrame })
  });
})();
`;
}

module.exports = { generateBridgeScript };
