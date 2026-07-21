'use strict';

let singleton = null;

class WindowsNativeHost {
  constructor() {
    this.binding = null;
    this.application = null;
    this.startPromise = null;
    this.windows = new Map();
    this.stopping = false;
  }

  async ensureStarted() {
    if (process.platform !== 'win32') {
      throw new Error('The in-process Windows native host can only run on Windows.');
    }
    if (!this.startPromise) {
      this.startPromise = this._start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    await this.startPromise;
  }

  async _start() {
    let binding;
    try {
      binding = require('@webviewjs/webview');
    } catch (error) {
      const wrapped = new Error([
        'AtomJS could not load the prebuilt Windows WebView binding.',
        'Delete node_modules and package-lock.json, then run npm install again.',
        'CMake and Visual Studio Build Tools are not required.',
        error && error.message ? error.message : String(error)
      ].join('\n'));
      wrapped.cause = error;
      throw wrapped;
    }

    this.binding = binding;
    this.application = new binding.Application();
    await this.application.whenReady({ interval: 16, ref: true });
  }

  async createWindow(atomWindow, config) {
    await this.ensureStarted();

    const parent = config.parentWindowId ? this.windows.get(Number(config.parentWindowId)) : null;
    const nativeOptions = {
      title: String(config.title || 'AtomJS App'),
      width: positive(config.width, 800),
      height: positive(config.height, 600),
      resizable: config.resizable !== false,
      visible: false,
      decorations: config.frame !== false,
      alwaysOnTop: Boolean(config.alwaysOnTop),
      maximizable: config.maximizable !== false,
      minimizable: config.minimizable !== false,
      focused: config.focusable !== false,
      transparent: Boolean(config.transparent),
      windowsSkipTaskbar: Boolean(config.skipTaskbar),
      windowsClassName: sanitizeWindowsClass(process.env.ATOM_APP_ID || process.env.ATOM_APP_NAME || config.title)
    };
    if (Number.isFinite(Number(config.x))) nativeOptions.x = Math.round(Number(config.x));
    if (Number.isFinite(Number(config.y))) nativeOptions.y = Math.round(Number(config.y));
    if (parent && parent.nativeWindow && typeof parent.nativeWindow.getNativeHandle === 'function') {
      nativeOptions.windowsOwnerWindow = parent.nativeWindow.getNativeHandle();
    }

    const nativeWindow = this.application.createBrowserWindow(nativeOptions);
    nativeWindow.setClosable(config.closable !== false);
    if (Number(config.minWidth) > 0 || Number(config.minHeight) > 0) {
      nativeWindow.setMinSize(positive(config.minWidth, 1), positive(config.minHeight, 1), true);
    }
    if (Number(config.maxWidth) > 0 || Number(config.maxHeight) > 0) {
      nativeWindow.setMaxSize(positive(config.maxWidth, 100000), positive(config.maxHeight, 100000), true);
    }
    if (config.center !== false && !Number.isFinite(Number(config.x)) && !Number.isFinite(Number(config.y))) {
      nativeWindow.center();
    }

    const webview = nativeWindow.createWebview({
      url: String(config.url),
      preload: String(config.bridgeScript || ''),
      enableDevtools: Boolean(config.debug),
      transparent: Boolean(config.transparent)
    });

    const record = { atomWindow, nativeWindow, webview };
    this.windows.set(Number(config.windowId), record);
    this._attachEvents(Number(config.windowId), record);

    if (config.show === false) nativeWindow.hide();
    else nativeWindow.show();
  }

  _attachEvents(windowId, record) {
    const emit = (event) => {
      if (!this.windows.has(windowId)) return;
      try { record.atomWindow._handleHostEvent({ ...event, windowId }); } catch {}
    };

    record.nativeWindow.on('close', () => {
      try { record.atomWindow._handleHostEvent({ type: 'closed', windowId }); } catch {}
      this.windows.delete(windowId);
    });
    record.nativeWindow.on('focus', () => emit({ type: 'focus' }));
    record.nativeWindow.on('blur', () => emit({ type: 'blur' }));
    record.nativeWindow.on('move', (event) => emit({
      type: 'bounds-changed',
      reason: 'move',
      bounds: { x: Number(event.x), y: Number(event.y) }
    }));
    record.nativeWindow.on('resize', (event) => emit({
      type: 'bounds-changed',
      reason: 'resize',
      bounds: { width: Number(event.width), height: Number(event.height) }
    }));
    record.webview.on('page-load-started', (event) => emit({ type: 'did-start-loading', url: event.url || '' }));
    record.webview.on('page-load-finished', (event) => emit({ type: 'did-finish-load', url: event.url || '' }));
    record.webview.on('title-changed', (event) => emit({ type: 'page-title-updated', title: event.title || '' }));
  }

  send(message) {
    const record = this.windows.get(Number(message.windowId));
    if (!record) return false;
    const win = record.nativeWindow;
    const view = record.webview;

    switch (message.command) {
      case 'navigate': view.loadUrl(String(message.url)); return true;
      case 'show': win.show(); return true;
      case 'hide': win.hide(); return true;
      case 'focus': win.focus(); return true;
      case 'close': win.close(); return true;
      case 'destroy':
        this.windows.delete(Number(message.windowId));
        try { view.dispose(); } catch {}
        try { win.dispose(); } catch {}
        return true;
      case 'set-title': win.setTitle(String(message.title || '')); return true;
      case 'set-always-on-top': win.setAlwaysOnTop(Boolean(message.value)); return true;
      case 'set-resizable': win.setResizable(Boolean(message.value)); return true;
      case 'fullscreen':
        win.setFullscreen(message.value ? this.binding.FullscreenType.Borderless : null);
        return true;
      case 'maximize': win.setMaximized(true); return true;
      case 'unmaximize': win.setMaximized(false); return true;
      case 'minimize': win.setMinimized(true); return true;
      case 'restore':
        win.setMinimized(false);
        win.setMaximized(false);
        win.show();
        return true;
      case 'set-bounds': {
        const bounds = message.bounds || {};
        if (Number.isFinite(Number(bounds.width)) && Number.isFinite(Number(bounds.height))) {
          win.setSize(Math.round(Number(bounds.width)), Math.round(Number(bounds.height)), true);
        }
        if (Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))) {
          win.setPosition(Math.round(Number(bounds.x)), Math.round(Number(bounds.y)), true);
        }
        return true;
      }
      default: return false;
    }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const record of this.windows.values()) {
      try { record.webview.dispose(); } catch {}
      try { record.nativeWindow.dispose(); } catch {}
    }
    this.windows.clear();
    if (this.application) {
      try { this.application.exit(); } catch {}
    }
    this.application = null;
    this.startPromise = null;
    this.stopping = false;
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function sanitizeWindowsClass(value) {
  return String(value || 'AtomJS.App').replace(/[^A-Za-z0-9._-]+/g, '.').slice(0, 120) || 'AtomJS.App';
}

function getWindowsNativeHost() {
  if (!singleton) singleton = new WindowsNativeHost();
  return singleton;
}

async function stopWindowsNativeHost() {
  if (!singleton) return;
  const current = singleton;
  singleton = null;
  await current.stop();
}

module.exports = { WindowsNativeHost, getWindowsNativeHost, stopWindowsNativeHost };
