'use strict';

const { EventEmitter } = require('node:events');
const { MessageChannel, MessagePort } = require('node:worker_threads');
const childProcess = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const state = require('./state.cjs');
const { BrowserWindow } = require('./browser-window.cjs');
const { WebContents } = require('./web-contents.cjs');

function compatibilityWarning(api) {
  console.warn(`[AtomJS Electron compatibility] ${api} is currently a compatibility stub.`);
}

class NativeImage {
  constructor(source = null) {
    this._source = source;
  }

  isEmpty() {
    return this._source == null;
  }

  getSize() {
    return { width: 0, height: 0 };
  }

  toPNG() {
    if (Buffer.isBuffer(this._source)) return Buffer.from(this._source);
    return Buffer.alloc(0);
  }

  toJPEG() {
    return this.toPNG();
  }

  toDataURL() {
    if (typeof this._source === 'string' && this._source.startsWith('data:')) return this._source;
    const data = this.toPNG();
    return `data:image/png;base64,${data.toString('base64')}`;
  }

  getNativeHandle() {
    return Buffer.alloc(0);
  }

  resize() {
    return this;
  }

  crop() {
    return this;
  }

  addRepresentation() {}

  setTemplateImage() {}

  isTemplateImage() {
    return false;
  }
}

const nativeImage = {
  createEmpty: () => new NativeImage(),
  createFromPath(filePath) {
    const absolute = path.resolve(String(filePath));
    return new NativeImage(fs.existsSync(absolute) ? absolute : null);
  },
  createFromBuffer(buffer) {
    return new NativeImage(Buffer.from(buffer || []));
  },
  createFromDataURL(dataUrl) {
    return new NativeImage(String(dataUrl));
  },
  createFromNamedImage(name) {
    return new NativeImage(String(name));
  }
};

class Notification extends EventEmitter {
  constructor(options = {}) {
    super();
    this.title = options.title || '';
    this.body = options.body || '';
    this.options = { ...options };
    this._shown = false;
  }

  show() {
    this._shown = true;
    queueMicrotask(() => this.emit('show'));
  }

  close() {
    if (!this._shown) return;
    this._shown = false;
    queueMicrotask(() => this.emit('close'));
  }

  static isSupported() {
    return true;
  }
}

class Session extends EventEmitter {
  constructor(partition = 'default') {
    super();
    this.partition = partition;
    this.webRequest = createWebRequest();
    this.cookies = createCookieStore();
  }

  clearCache() {
    return Promise.resolve();
  }

  clearStorageData() {
    return Promise.resolve();
  }

  flushStorageData() {}

  getCacheSize() {
    return Promise.resolve(0);
  }

  setProxy() {
    return Promise.resolve();
  }

  resolveProxy() {
    return Promise.resolve('DIRECT');
  }

  setPermissionRequestHandler(handler) {
    this._permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(handler) {
    this._permissionCheckHandler = handler;
  }

  setUserAgent() {}

  getUserAgent() {
    return `AtomJS/${process.versions.atomjs || '0.2.0'} SystemWebView`;
  }
}

function createWebRequest() {
  const handlers = new Map();
  const api = {};
  for (const name of [
    'onBeforeRequest',
    'onBeforeSendHeaders',
    'onSendHeaders',
    'onHeadersReceived',
    'onResponseStarted',
    'onBeforeRedirect',
    'onCompleted',
    'onErrorOccurred'
  ]) {
    api[name] = (...args) => {
      const listener = args.find((arg) => typeof arg === 'function') || null;
      handlers.set(name, listener);
    };
  }
  api._handlers = handlers;
  return api;
}

function createCookieStore() {
  const entries = [];
  return {
    async get(filter = {}) {
      return entries.filter((entry) => Object.entries(filter).every(([key, value]) => entry[key] === value));
    },
    async set(details) {
      entries.push({ ...details });
    },
    async remove(url, name) {
      for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index].url === url && entries[index].name === name) entries.splice(index, 1);
      }
    },
    async flushStore() {}
  };
}

const sessions = new Map();
const session = {
  get defaultSession() {
    return session.fromPartition('default');
  },
  fromPartition(partition = 'default') {
    const key = String(partition);
    if (!sessions.has(key)) sessions.set(key, new Session(key));
    return sessions.get(key);
  }
};

const protocolHandlers = new Map();
const protocol = {
  registerSchemesAsPrivileged() {},
  registerFileProtocol(scheme, handler) {
    protocolHandlers.set(String(scheme), handler);
  },
  registerBufferProtocol(scheme, handler) {
    protocolHandlers.set(String(scheme), handler);
  },
  registerStringProtocol(scheme, handler) {
    protocolHandlers.set(String(scheme), handler);
  },
  handle(scheme, handler) {
    protocolHandlers.set(String(scheme), handler);
  },
  unhandle(scheme) {
    protocolHandlers.delete(String(scheme));
  },
  unregisterProtocol(scheme) {
    protocolHandlers.delete(String(scheme));
    return Promise.resolve();
  },
  isProtocolHandled(scheme) {
    return Promise.resolve(protocolHandlers.has(String(scheme)));
  }
};

const shortcuts = new Map();
const globalShortcut = {
  register(accelerator, callback) {
    shortcuts.set(String(accelerator), callback);
    compatibilityWarning('globalShortcut.register');
    return false;
  },
  registerAll(accelerators, callback) {
    for (const accelerator of accelerators || []) shortcuts.set(String(accelerator), callback);
  },
  isRegistered(accelerator) {
    return shortcuts.has(String(accelerator));
  },
  unregister(accelerator) {
    shortcuts.delete(String(accelerator));
  },
  unregisterAll() {
    shortcuts.clear();
  }
};

let powerSaveSequence = 0;
const powerSaveIds = new Set();
const powerSaveBlocker = {
  start() {
    const id = ++powerSaveSequence;
    powerSaveIds.add(id);
    return id;
  },
  stop(id) {
    return powerSaveIds.delete(Number(id));
  },
  isStarted(id) {
    return powerSaveIds.has(Number(id));
  }
};

const primaryDisplay = {
  id: 1,
  rotation: 0,
  scaleFactor: 1,
  touchSupport: 'unknown',
  monochrome: false,
  accelerometerSupport: 'unknown',
  colorSpace: 'unknown',
  colorDepth: 24,
  depthPerComponent: 8,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  size: { width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1040 },
  internal: true
};
const screen = Object.assign(new EventEmitter(), {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getPrimaryDisplay: () => ({ ...primaryDisplay }),
  getAllDisplays: () => [{ ...primaryDisplay }],
  getDisplayNearestPoint: () => ({ ...primaryDisplay }),
  getDisplayMatching: () => ({ ...primaryDisplay })
});

const net = {
  fetch(input, init) {
    return globalThis.fetch(input, init);
  },
  isOnline() {
    return true;
  },
  request(options) {
    const target = typeof options === 'string' || options instanceof URL ? options : options.url || options;
    const transport = String(target).startsWith('https:') ? https : http;
    return transport.request(options);
  },
  resolveHost(host) {
    return Promise.resolve({ endpoints: [{ address: String(host), family: 'unspecified' }] });
  }
};

const safeStorage = {
  isEncryptionAvailable() {
    return false;
  },
  encryptString() {
    throw new Error('AtomJS safeStorage is unavailable until a platform keychain adapter is installed.');
  },
  decryptString() {
    throw new Error('AtomJS safeStorage is unavailable until a platform keychain adapter is installed.');
  },
  setUsePlainTextEncryption() {}
};

const desktopCapturer = {
  async getSources() {
    compatibilityWarning('desktopCapturer.getSources');
    return [];
  }
};

const systemPreferences = Object.assign(new EventEmitter(), {
  isDarkMode: () => false,
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  getAccentColor: () => '000000',
  getColor: () => '#000000',
  getSystemColor: () => '#000000',
  askForMediaAccess: async () => false,
  getMediaAccessStatus: () => 'not-determined',
  canPromptTouchID: () => false,
  promptTouchID: async () => { throw new Error('Touch ID is not available through the AtomJS pure-JavaScript runtime.'); }
});

const powerMonitor = Object.assign(new EventEmitter(), {
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false
});

const crashReporter = {
  start() {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer() {},
  addExtraParameter() {},
  removeExtraParameter() {},
  getParameters: () => ({}),
  getCrashesDirectory: () => ''
};

const autoUpdater = Object.assign(new EventEmitter(), {
  setFeedURL() {},
  getFeedURL: () => '',
  checkForUpdates() {
    const error = new Error('AtomJS autoUpdater is not configured.');
    queueMicrotask(() => autoUpdater.emit('error', error));
    return Promise.reject(error);
  },
  quitAndInstall() {}
});

const contentTracing = {
  getCategories: async () => [],
  startRecording: async () => {},
  stopRecording: async () => ''
};

const netLog = {
  startLogging: async () => {},
  stopLogging: async () => ''
};

const utilityProcess = {
  fork(modulePath, args = [], options = {}) {
    return childProcess.fork(modulePath, args, options);
  }
};

class MessageChannelMain {
  constructor() {
    const channel = new MessageChannel();
    this.port1 = channel.port1;
    this.port2 = channel.port2;
  }
}

class BrowserView extends EventEmitter {
  constructor(options = {}) {
    super();
    this.webContents = new WebContents({
      id: -Date.now(),
      isDestroyed: () => false,
      _currentUrl: '',
      options
    });
    this._bounds = { x: 0, y: 0, width: 0, height: 0 };
  }
  setBounds(bounds) { this._bounds = { ...this._bounds, ...bounds }; }
  getBounds() { return { ...this._bounds }; }
  setAutoResize() {}
  setBackgroundColor() {}
}

class WebContentsView extends BrowserView {}
class View extends EventEmitter {}
class ImageView extends View {}
class BaseWindow extends BrowserWindow {}

class TouchBar {
  constructor(options = {}) { Object.assign(this, options); }
}
for (const name of ['TouchBarButton', 'TouchBarColorPicker', 'TouchBarGroup', 'TouchBarLabel', 'TouchBarOtherItemsProxy', 'TouchBarPopover', 'TouchBarScrubber', 'TouchBarSegmentedControl', 'TouchBarSlider', 'TouchBarSpacer']) {
  TouchBar[name] = class { constructor(options = {}) { Object.assign(this, options); } };
}

const webContents = {
  getAllWebContents() {
    return BrowserWindow.getAllWindows().map((window) => window.webContents);
  },
  getFocusedWebContents() {
    const window = BrowserWindow.getFocusedWindow();
    return window ? window.webContents : null;
  },
  fromId(id) {
    return webContents.getAllWebContents().find((contents) => contents.id === Number(id)) || null;
  },
  fromFrame() {
    return null;
  },
  fromDevToolsTargetId() {
    return null;
  }
};

const pushNotifications = Object.assign(new EventEmitter(), {
  registerForAPNSNotifications: async () => {},
  unregisterForAPNSNotifications() {}
});

const inAppPurchase = Object.assign(new EventEmitter(), {
  canMakePayments: () => false,
  getProducts: async () => [],
  purchaseProduct: async () => false,
  restoreCompletedTransactions() {},
  getReceiptURL: () => ''
});

const parentPort = null;

module.exports = {
  BaseWindow,
  BrowserView,
  WebContentsView,
  View,
  ImageView,
  Notification,
  Session,
  TouchBar,
  MessageChannelMain,
  MessagePortMain: MessagePort,
  autoUpdater,
  contentTracing,
  crashReporter,
  desktopCapturer,
  globalShortcut,
  inAppPurchase,
  nativeImage,
  net,
  netLog,
  parentPort,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  pushNotifications,
  safeStorage,
  screen,
  session,
  systemPreferences,
  utilityProcess,
  webContents
};
