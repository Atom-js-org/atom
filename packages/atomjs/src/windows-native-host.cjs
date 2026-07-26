'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getWindowsNativeDragApi, getWindowsNativeShapeApi } = require('./windows-native-drag.cjs');

let singleton = null;

class WindowsNativeHost {
  constructor() {
    this.binding = null;
    this.application = null;
    this.webContext = null;
    this.shapeApi = null;
    this.webviewDataDirectory = null;
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

    this.webviewDataDirectory = resolveWritableWebViewDataDirectory();
    try {
      this.webContext = this.application.createWebContext({
        dataDirectory: this.webviewDataDirectory,
        allowsAutomation: false
      });
    } catch (error) {
      const wrapped = new Error([
        'AtomJS could not create a writable WebView2 data directory.',
        `Directory: ${this.webviewDataDirectory}`,
        'Check that the current Windows user can write to LOCALAPPDATA.',
        error && error.message ? error.message : String(error)
      ].join('\n'));
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async createWindow(atomWindow, config) {
    await this.ensureStarted();

    const parent = config.parentWindowId ? this.windows.get(Number(config.parentWindowId)) : null;
    const nativeOptions = {
      title: String(config.title || 'AtomJS App'),
      width: positive(config.width, 800),
      height: positive(config.height, 600),
      logical: true,
      resizable: config.resizable !== false,
      visible: false,
      decorations: config.frame !== false,
      alwaysOnTop: Boolean(config.alwaysOnTop),
      maximizable: config.maximizable !== false,
      minimizable: config.minimizable !== false,
      focused: config.focusable !== false,
      transparent: Boolean(config.transparent),
      // Frameless windows draw their own CSS/native shape. Letting Tao/DWM add
      // the undecorated shadow leaves a bright edge around rounded WebView2
      // windows on some Windows 11 themes.
      windowsUndecoratedShadow: config.frame !== false,
      windowsSkipTaskbar: Boolean(config.skipTaskbar),
      windowsClassName: sanitizeWindowsClass(process.env.ATOM_APP_ID || process.env.ATOM_APP_NAME || config.title)
    };
    if (Number.isFinite(Number(config.x))) nativeOptions.x = Math.round(Number(config.x));
    if (Number.isFinite(Number(config.y))) nativeOptions.y = Math.round(Number(config.y));
    if (parent && parent.nativeWindow && typeof parent.nativeWindow.getNativeHandle === 'function') {
      nativeOptions.windowsOwnerWindow = parent.nativeWindow.getNativeHandle();
    }

    const nativeWindow = this.application.createBrowserWindow(nativeOptions);
    if (config.frame === false && typeof nativeWindow.setUndecoratedShadow === 'function') {
      try { nativeWindow.setUndecoratedShadow(false); } catch {}
    }
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
      transparent: Boolean(config.transparent),
      webContext: this.webContext
    });
    applyWebViewBackground(webview, config.backgroundColor, config.transparent === true);

    const record = {
      windowId: Number(config.windowId),
      atomWindow,
      nativeWindow,
      webview,
      dragRegions: [],
      dragViewport: {
        width: positive(config.width, 800),
        height: positive(config.height, 600)
      },
      lastDragClick: null,
      nativeDragPending: false,
      fullscreen: false,
      cornerRadius: normalizeCornerRadius(config.cornerRadius, config.frame === false ? 18 : 0)
    };
    this.windows.set(Number(config.windowId), record);
    this._attachEvents(Number(config.windowId), record);
    this._applyWindowShape(record);

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
    record.nativeWindow.on('move', (event) => {
      if (record.nativeDragPending) {
        record.nativeDragPending = false;
        record.lastDragClick = null;
      }
      const scale = safeScaleFactor(record.nativeWindow);
      emit({
        type: 'bounds-changed',
        reason: 'move',
        bounds: { x: Number(event.x) / scale, y: Number(event.y) / scale }
      });
    });
    record.nativeWindow.on('resize', (event) => {
      this._applyWindowShape(record);
      const scale = safeScaleFactor(record.nativeWindow);
      emit({
        type: 'bounds-changed',
        reason: 'resize',
        bounds: { width: Number(event.width) / scale, height: Number(event.height) / scale }
      });
    });
    record.nativeWindow.on('mouse-down', (event) => {
      if (Number(event.button) !== 0) return;
      const point = physicalPoint(event);
      if (!point || !isDraggablePoint(record, point)) return;
      this._startNativeWindowDrag(record, point);
    });
    record.nativeWindow.on('mouse-up', (event) => {
      if (Number(event.button) === 0) record.nativeDragPending = false;
    });
    record.webview.on('page-load-started', (event) => emit({ type: 'did-start-loading', url: event.url || '' }));
    record.webview.on('page-load-finished', (event) => emit({ type: 'did-finish-load', url: event.url || '' }));
    record.webview.on('title-changed', (event) => emit({ type: 'page-title-updated', title: event.title || '' }));
  }

  _applyWindowShape(record) {
    if (!record || record.cornerRadius <= 0) return;
    if (!this.shapeApi) this.shapeApi = getWindowsNativeShapeApi();
    if (!this.shapeApi) return;

    let maximized = false;
    try { maximized = record.nativeWindow.isMaximized() === true; } catch {}
    if (record.fullscreen || maximized) {
      try { this.shapeApi.clearRoundedCorners(record.nativeWindow); } catch {}
      return;
    }

    try { this.shapeApi.setRoundedCorners(record.nativeWindow, record.cornerRadius); } catch {}
  }

  _startNativeWindowDrag(record, point = null) {
    // SpaceClient and Electron-compatible apps may both request a drag: one
    // through app-region metadata and one through startDrag(). Do not enqueue
    // two Win32 move messages for the same mouse press.
    if (record.nativeDragPending) return true;

    const nativeDrag = getWindowsNativeDragApi();
    if (!nativeDrag) return false;

    if (point && isSystemDoubleClick(record, point, nativeDrag.doubleClickSettings())) {
      record.lastDragClick = null;
      try { record.nativeWindow.setMaximized(!record.nativeWindow.isMaximized()); } catch {}
      return true;
    }

    const started = nativeDrag.startWindowDrag(record.nativeWindow);
    if (!started) return false;

    // The Win32 move loop is queued asynchronously. Native move events keep the
    // BrowserWindow bounds synchronized while Windows owns the pointer.
    record.nativeDragPending = true;
    return true;
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
        record.fullscreen = Boolean(message.value);
        win.setFullscreen(message.value ? this.binding.FullscreenType.Borderless : null);
        this._applyWindowShape(record);
        return true;
      case 'maximize':
        win.setMaximized(true);
        this._applyWindowShape(record);
        return true;
      case 'unmaximize':
        win.setMaximized(false);
        this._applyWindowShape(record);
        return true;
      case 'minimize': win.setMinimized(true); return true;
      case 'restore':
        win.setMinimized(false);
        win.setMaximized(false);
        win.show();
        return true;
      case 'set-drag-regions':
        record.dragRegions = normalizeDragRegions(message.regions);
        record.dragViewport = normalizeViewport(message.viewport, win);
        return true;
      case 'start-drag':
        return this._startNativeWindowDrag(record);
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
    if (this.webContext) {
      try { this.webContext.dispose(); } catch {}
    }
    if (this.application) {
      try { this.application.exit(); } catch {}
    }
    this.webContext = null;
    this.webviewDataDirectory = null;
    this.application = null;
    this.startPromise = null;
    this.stopping = false;
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function normalizeCornerRadius(value, fallback) {
  if (value === false || value === 0 || value === '0') return 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return Math.round(number);
  return fallback;
}

function applyWebViewBackground(webview, value, transparent) {
  if (!webview || typeof webview.setBackgroundColor !== 'function') return;
  const color = parseColor(value, transparent);
  try {
    webview.setBackgroundColor(color.r, color.g, color.b, color.a);
  } catch {}
}

function parseColor(value, transparent = false) {
  const fallback = {
    r: transparent ? 0 : 255,
    g: transparent ? 0 : 255,
    b: transparent ? 0 : 255,
    a: transparent ? 0 : 255
  };

  const text = String(value || '').trim();
  const match = text.match(/^#([0-9a-f]{3,8})$/i);
  if (!match) return fallback;
  const hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    const channels = [...hex].map((channel) => Number.parseInt(channel + channel, 16));
    const color = { r: channels[0], g: channels[1], b: channels[2], a: transparent ? channels[3] ?? 0 : channels[3] ?? 255 };
    return color.a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : color;
  }
  if (hex.length === 6 || hex.length === 8) {
    const color = {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: transparent ? Number.parseInt(hex.slice(6, 8) || '00', 16) : Number.parseInt(hex.slice(6, 8) || 'ff', 16)
    };
    return color.a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : color;
  }
  return fallback;
}

function safeScaleFactor(win) {
  try {
    const scale = Number(win.scaleFactor());
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  } catch {
    return 1;
  }
}

function physicalPoint(event) {
  const x = Number(event && event.x);
  const y = Number(event && event.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function normalizeDragRegions(regions) {
  const normalized = [];
  for (const region of Array.isArray(regions) ? regions.slice(0, 4096) : []) {
    const x = Number(region && region.x);
    const y = Number(region && region.y);
    const width = Number(region && region.width);
    const height = Number(region && region.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    normalized.push({ x, y, width, height, draggable: region.draggable === true });
  }
  return normalized;
}

function normalizeViewport(viewport, win) {
  let fallback = { width: 1, height: 1 };
  try {
    const size = win.getInnerSize(true);
    fallback = { width: positive(size.width, 1), height: positive(size.height, 1) };
  } catch {}
  const width = Number(viewport && viewport.width);
  const height = Number(viewport && viewport.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallback.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.height
  };
}

function isDraggablePoint(record, physical) {
  if (!record.dragRegions.length) return false;
  const scale = safeScaleFactor(record.nativeWindow);
  const logical = { x: physical.x / scale, y: physical.y / scale };
  let inner = { width: record.dragViewport.width, height: record.dragViewport.height };
  try { inner = record.nativeWindow.getInnerSize(true); } catch {}
  const scaleX = record.dragViewport.width > 0 ? Number(inner.width) / record.dragViewport.width : 1;
  const scaleY = record.dragViewport.height > 0 ? Number(inner.height) / record.dragViewport.height : 1;
  let draggable = false;

  for (const region of record.dragRegions) {
    const inside = logical.x >= region.x * scaleX &&
      logical.x < (region.x + region.width) * scaleX &&
      logical.y >= region.y * scaleY &&
      logical.y < (region.y + region.height) * scaleY;
    if (!inside) continue;
    if (!region.draggable) return false;
    draggable = true;
  }
  return draggable;
}

function isSystemDoubleClick(record, point, settings) {
  const now = Date.now();
  const previous = record.lastDragClick;
  record.lastDragClick = { time: now, x: point.x, y: point.y };
  if (!previous) return false;

  const halfWidth = Math.max(1, Number(settings && settings.width) / 2);
  const halfHeight = Math.max(1, Number(settings && settings.height) / 2);
  return now - previous.time <= Number(settings && settings.time || 500) &&
    Math.abs(Number(previous.x) - Number(point.x)) <= halfWidth &&
    Math.abs(Number(previous.y) - Number(point.y)) <= halfHeight;
}


function resolveWritableWebViewDataDirectory() {
  const identity = sanitizePathSegment(
    process.env.ATOM_APP_ID || process.env.ATOM_APP_NAME || 'AtomJS.App'
  );
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, identity, 'AtomJS', 'WebView2'),
    path.join(os.tmpdir(), identity, 'AtomJS', 'WebView2')
  ];
  let lastError;

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`No writable WebView2 data directory was available: ${lastError ? lastError.message : 'unknown error'}`);
}

function sanitizePathSegment(value) {
  return String(value || 'AtomJS.App')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'AtomJS.App';
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

module.exports = {
  WindowsNativeHost,
  getWindowsNativeHost,
  stopWindowsNativeHost,
  isDraggablePoint,
  normalizeDragRegions,
  resolveWritableWebViewDataDirectory,
  isSystemDoubleClick,
  parseColor
};
