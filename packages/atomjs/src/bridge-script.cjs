'use strict';

function generateBridgeScript({ websocketUrl, preloadCode = '', nativeResize = false }) {
  const endpoint = JSON.stringify(websocketUrl);
  const preload = JSON.stringify(preloadCode);
  const resizeEnabled = JSON.stringify(Boolean(nativeResize));

  return `
(() => {
  'use strict';

  const endpoint = ${endpoint};
  const preloadSource = ${preload};
  const nativeResizeEnabled = ${resizeEnabled};
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

  function windowResizeDirection(x, y) {
    if (!nativeResizeEnabled) return '';
    const edge = 8;
    const width = Math.max(0, Number(window.innerWidth) || 0);
    const height = Math.max(0, Number(window.innerHeight) || 0);
    const left = x >= 0 && x <= edge;
    const right = x >= width - edge && x <= width;
    const top = y >= 0 && y <= edge;
    const bottom = y >= height - edge && y <= height;
    if (top && left) return 'north-west';
    if (top && right) return 'north-east';
    if (bottom && left) return 'south-west';
    if (bottom && right) return 'south-east';
    if (left) return 'west';
    if (right) return 'east';
    if (top) return 'north';
    if (bottom) return 'south';
    return '';
  }

  window.addEventListener('pointerdown', (event) => {
    if (!nativeResizeEnabled || event.button !== 0 || event.isPrimary === false) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const direction = windowResizeDirection(Number(event.clientX), Number(event.clientY));
    if (!direction) return;
    sendNow({ type: 'system', command: 'start-window-resize', direction });
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function normalizeAppRegion(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'drag' || normalized === 'no-drag' ? normalized : '';
  }

  function appRegionForElement(element) {
    if (!(element instanceof Element)) return '';
    if (element.hasAttribute('data-atom-no-drag')) return 'no-drag';
    if (element.hasAttribute('data-atom-drag-region')) return 'drag';

    const attribute = normalizeAppRegion(
      element.getAttribute('data-atom-app-region') || element.getAttribute('data-app-region')
    );
    if (attribute) return attribute;

    const inline = normalizeAppRegion(
      element.style && (
        element.style.getPropertyValue('-webkit-app-region') ||
        element.style.getPropertyValue('app-region') ||
        element.style.getPropertyValue('--atom-app-region')
      )
    );
    if (inline) return inline;

    try {
      const computed = getComputedStyle(element);
      return normalizeAppRegion(
        computed.getPropertyValue('-webkit-app-region') ||
        computed.getPropertyValue('app-region') ||
        computed.getPropertyValue('--atom-app-region')
      );
    } catch {
      return '';
    }
  }

  function collectStylesheetAppRegions() {
    const regions = new Map();

    function visitRules(rules) {
      for (const rule of rules || []) {
        if (rule && rule.cssRules) {
          visitRules(rule.cssRules);
          continue;
        }
        if (!rule || !rule.selectorText || !rule.style) continue;

        const match = String(rule.cssText || '').match(
          /(?:-webkit-app-region|app-region)\s*:\s*(drag|no-drag)/i
        );
        const region = normalizeAppRegion(
          rule.style.getPropertyValue('-webkit-app-region') ||
          rule.style.getPropertyValue('app-region') ||
          rule.style.getPropertyValue('--atom-app-region') ||
          (match && match[1])
        );
        if (!region) continue;

        try {
          for (const element of document.querySelectorAll(rule.selectorText)) {
            regions.set(element, region);
          }
        } catch {}
      }
    }

    for (const sheet of document.styleSheets || []) {
      try {
        visitRules(sheet.cssRules);
      } catch {}
    }

    return regions;
  }

  function composedParent(element) {
    if (!(element instanceof Element)) return null;
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode && element.getRootNode();
    return root && root.host instanceof Element ? root.host : null;
  }

  function isInteractiveElement(element) {
    return element instanceof Element && element.matches(
      'button, input, textarea, select, option, a[href], [contenteditable=""], [contenteditable="true"], [role="button"]'
    );
  }

  function hasDraggableAncestor(element) {
    let current = composedParent(element);
    while (current) {
      const region = appRegionForElement(current);
      if (region === 'no-drag') return false;
      if (region === 'drag') return true;
      current = composedParent(current);
    }
    return false;
  }

  const observedDragRoots = new WeakSet();
  let dragRegionObserver = null;
  let dragRegionFrame = 0;
  let lastDragRegionPayload = '';

  function observeDragRoot(root) {
    if (!dragRegionObserver || !root || observedDragRoots.has(root)) return;
    observedDragRoots.add(root);
    dragRegionObserver.observe(root, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'data-atom-drag-region',
        'data-atom-no-drag',
        'data-atom-app-region',
        'data-app-region'
      ]
    });
  }

  function walkRegionElements(root, visitor) {
    const stack = [];
    if (root && root.documentElement instanceof Element) {
      stack.push(root.documentElement);
    } else if (root && root.children) {
      for (let index = root.children.length - 1; index >= 0; index -= 1) {
        stack.push(root.children[index]);
      }
    }

    while (stack.length > 0) {
      const element = stack.pop();
      if (!(element instanceof Element)) continue;
      visitor(element);

      if (element.shadowRoot) {
        observeDragRoot(element.shadowRoot);
        for (let index = element.shadowRoot.children.length - 1; index >= 0; index -= 1) {
          stack.push(element.shadowRoot.children[index]);
        }
      }

      for (let index = element.children.length - 1; index >= 0; index -= 1) {
        stack.push(element.children[index]);
      }
    }
  }

  function roundedRegionNumber(value) {
    return Math.round(Number(value) * 4) / 4;
  }

  function collectWindowDragRegions() {
    const regions = [];
    const stylesheetRegions = collectStylesheetAppRegions();
    const viewportWidth = Math.max(0, Number(window.innerWidth) || 0);
    const viewportHeight = Math.max(0, Number(window.innerHeight) || 0);

    walkRegionElements(document, (element) => {
      let region = appRegionForElement(element) || stylesheetRegions.get(element) || '';
      if (!region && isInteractiveElement(element) && hasDraggableAncestor(element)) {
        region = 'no-drag';
      }
      if (!region) return;

      let style;
      try {
        style = getComputedStyle(element);
      } catch {
        return;
      }
      if (style.display === 'none' || style.visibility === 'hidden') return;

      const rect = element.getBoundingClientRect();
      const left = Math.max(0, Math.min(viewportWidth, rect.left));
      const top = Math.max(0, Math.min(viewportHeight, rect.top));
      const right = Math.max(0, Math.min(viewportWidth, rect.right));
      const bottom = Math.max(0, Math.min(viewportHeight, rect.bottom));
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return;

      regions.push({
        x: roundedRegionNumber(left),
        y: roundedRegionNumber(top),
        width: roundedRegionNumber(width),
        height: roundedRegionNumber(height),
        draggable: region === 'drag'
      });
    });

    return {
      type: 'system',
      command: 'set-window-drag-regions',
      viewport: {
        width: roundedRegionNumber(viewportWidth),
        height: roundedRegionNumber(viewportHeight)
      },
      deviceScaleFactor: Number(window.devicePixelRatio) || 1,
      regions
    };
  }

  function publishWindowDragRegions() {
    dragRegionFrame = 0;
    const payload = collectWindowDragRegions();
    const serialized = JSON.stringify(payload);
    if (serialized === lastDragRegionPayload) return;
    lastDragRegionPayload = serialized;
    sendNow(payload);
  }

  function scheduleWindowDragRegionUpdate() {
    if (dragRegionFrame) return;
    dragRegionFrame = requestAnimationFrame(publishWindowDragRegions);
  }

  function activateWindowDragRegions() {
    observeDragRoot(document.documentElement);
    scheduleWindowDragRegionUpdate();

    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(scheduleWindowDragRegionUpdate);
      resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
    }
  }

  dragRegionObserver = new MutationObserver(scheduleWindowDragRegionUpdate);
  window.addEventListener('resize', scheduleWindowDragRegionUpdate, { passive: true });
  window.addEventListener('scroll', scheduleWindowDragRegionUpdate, { capture: true, passive: true });
  window.addEventListener('transitionend', scheduleWindowDragRegionUpdate, true);
  window.addEventListener('animationend', scheduleWindowDragRegionUpdate, true);
  window.addEventListener('load', scheduleWindowDragRegionUpdate, { once: true });
  document.addEventListener('load', scheduleWindowDragRegionUpdate, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', activateWindowDragRegions, { once: true });
  } else {
    activateWindowDragRegions();
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
