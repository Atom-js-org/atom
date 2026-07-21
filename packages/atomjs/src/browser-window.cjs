'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const state = require('./state.cjs');
const app = require('./app.cjs');
const { WebContents } = require('./web-contents.cjs');
const { generateBridgeScript } = require('./bridge-script.cjs');
const { getNativeHost } = require('./native-host.cjs');
const { getWindowsNativeHost } = require('./windows-native-host.cjs');

class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = state.nextWindowId++;
    const explicitParent = options.parent instanceof BrowserWindow && !options.parent.isDestroyed()
      ? options.parent
      : null;
    const modalParent = !explicitParent && options.modal === true
      ? BrowserWindow.getFocusedWindow()
      : null;
    this._parent = explicitParent || modalParent || null;
    this._children = new Set();
    this.options = normalizeOptions(options);
    this.webContents = new WebContents(this);
    this._child = null;
    this._nativeHost = null;
    this._hostAttached = false;
    this._destroyed = false;
    this._rendererReady = false;
    this._visible = this.options.show;
    this._contentRoot = null;
    this._currentUrl = '';
    this._pendingLoad = null;
    this._menu = null;
    this._menuBarVisible = true;
    this._lastFinishedLoad = null;
    this._fullScreen = false;
    this._maximized = false;
    this._minimized = false;
    this._alwaysOnTop = this.options.alwaysOnTop;
    this._opacity = this.options.opacity;
    this._bounds = {
      x: this.options.x == null ? 0 : this.options.x,
      y: this.options.y == null ? 0 : this.options.y,
      width: this.options.width,
      height: this.options.height
    };
    if (this._parent) this._parent._children.add(this);
    state.windows.set(this.id, this);
  }

  loadFile(filePath) {
    const task = this._loadFile(filePath);
    task.catch(() => {});
    return task;
  }

  async _loadFile(filePath) {
    const absolute = path.resolve(state.projectRoot, filePath);
    const stat = await fs.promises.stat(absolute);
    if (!stat.isFile()) throw new Error(`BrowserWindow.loadFile expected a file: ${absolute}`);
    this._contentRoot = path.dirname(absolute);
    await app.whenReady();
    const url = state.bridgeServer.fileUrl(this.id, path.basename(absolute));
    return this._load(url);
  }

  loadURL(url) {
    const task = this._loadURL(url);
    task.catch(() => {});
    return task;
  }

  async _loadURL(url) {
    await app.whenReady();
    return this._load(String(url));
  }

  async _load(url) {
    if (this._destroyed) throw new Error('BrowserWindow has been destroyed');
    this._currentUrl = String(url);

    if (this._hostAttached) {
      this._sendHostCommand({ command: 'navigate', url: this._currentUrl });
      return;
    }

    const preloadPath = this.options.webPreferences.preload;
    let preloadCode = '';
    if (preloadPath) preloadCode = await fs.promises.readFile(path.resolve(preloadPath), 'utf8');

    const config = {
      windowId: this.id,
      title: this.options.title || app.getName(),
      width: this.options.width,
      height: this.options.height,
      x: this.options.x,
      y: this.options.y,
      resizable: this.options.resizable,
      center: this.options.center,
      frame: this.options.frame,
      parentWindowId: this._parent ? this._parent.id : null,
      parentProcessId: this._parent && this._parent._child ? this._parent._child.pid : null,
      modal: this.options.modal,
      alwaysOnTop: this.options.alwaysOnTop,
      focusable: this.options.focusable,
      closable: this.options.closable,
      minimizable: this.options.minimizable,
      maximizable: this.options.maximizable,
      fullscreenable: this.options.fullscreenable,
      skipTaskbar: this.options.skipTaskbar,
      transparent: this.options.transparent,
      opacity: this.options.opacity,
      titleBarStyle: this.options.titleBarStyle,
      trafficLightPosition: this.options.trafficLightPosition,
      minWidth: this.options.minWidth,
      minHeight: this.options.minHeight,
      maxWidth: this.options.maxWidth,
      maxHeight: this.options.maxHeight,
      show: this.options.show,
      backgroundColor: this.options.backgroundColor,
      debug: Boolean(this.options.webPreferences.devTools || process.env.ATOM_DEV === '1'),
      url: this._currentUrl,
      bridgeScript: generateBridgeScript({
        websocketUrl: state.bridgeServer.websocketUrl(this.id),
        preloadCode
      })
    };

    this._pendingLoad = this._createPendingLoad();

    if (process.platform === 'darwin') {
      this._nativeHost = getNativeHost(app.getName());
      this._hostAttached = true;
      await this._nativeHost.createWindow(this, config);
    } else if (process.platform === 'win32') {
      this._nativeHost = getWindowsNativeHost();
      this._hostAttached = true;
      await this._nativeHost.createWindow(this, config);
    } else {
      await this._startLegacyHost(config);
    }

    this._pendingLoad.catch(() => {});
    return this._pendingLoad;
  }

  async _startLegacyHost(config) {
    const configPath = path.join(os.tmpdir(), `atomjs-window-${process.pid}-${this.id}-${Date.now()}.json`);
    await fs.promises.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    const hostPath = process.env.ATOM_WINDOW_HOST_ENTRY || path.join(__dirname, 'runtime', 'window-host.mjs');
    const nodeExecutable = process.env.ATOM_NODE_EXECUTABLE || process.execPath;
    const hostArgs = process.env.ATOM_EMBEDDED_RUNTIME === '1'
      ? ['--atomjs-window-host', configPath]
      : [hostPath, configPath];
    this._child = spawn(nodeExecutable, hostArgs, {
      cwd: state.projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true
    });
    this._hostAttached = true;
    attachHostOutput(this, this._child);

    this._child.once('error', (error) => {
      this.emit('unresponsive');
      this.emit('error', error);
    });

    this._child.once('exit', (code, signal) => {
      this._child = null;
      if (!this._destroyed) {
        const failedBeforeReady = !this._rendererReady && code !== 0 && signal == null;
        if (failedBeforeReady) {
          process.exitCode = code || 1;
          this.webContents.emit(
            'did-fail-load',
            {},
            code || 1,
            'AtomJS window host exited before the renderer became ready',
            this._currentUrl,
            true
          );
        }
        this._finalizeClosed({ code, signal });
      }
    });
  }

  _createPendingLoad() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Renderer did not become ready within 20 seconds'));
      }, 20000);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onClosed = () => {
        cleanup();
        reject(new Error('Window closed before the page finished loading'));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('ready-to-show', onReady);
        this.off('closed', onClosed);
      };
      this.once('ready-to-show', onReady);
      this.once('closed', onClosed);
    });
  }

  _sendHostCommand(command) {
    if (this._nativeHost) {
      return this._nativeHost.send({ ...command, windowId: this.id }) !== false;
    }
    return false;
  }

  _startNativeDrag() {
    if (this._destroyed) return false;
    return this._sendHostCommand({ command: 'start-drag' });
  }

  _setNativeDragRegions(regions, viewport) {
    if (this._destroyed) return false;

    const normalizedRegions = [];
    for (const region of Array.isArray(regions) ? regions.slice(0, 4096) : []) {
      const x = Number(region && region.x);
      const y = Number(region && region.y);
      const width = Number(region && region.width);
      const height = Number(region && region.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      normalizedRegions.push({
        x,
        y,
        width,
        height,
        draggable: region.draggable === true
      });
    }

    const viewportWidth = Number(viewport && viewport.width);
    const viewportHeight = Number(viewport && viewport.height);
    const normalizedViewport = {
      width: Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : this._bounds.width,
      height: Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : this._bounds.height
    };

    return this._sendHostCommand({
      command: 'set-drag-regions',
      regions: normalizedRegions,
      viewport: normalizedViewport
    });
  }

  _markRendererReady(details) {
    this._notifyDidFinishLoad(details && details.href ? details.href : this._currentUrl, 'bridge');
  }

  _handleHostEvent(event) {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'closed') {
      this._finalizeClosed({ code: 0, signal: null });
      return;
    }
    if (event.type === 'focus') {
      state.focusedWindowId = this.id;
      this.emit('focus');
      return;
    }
    if (event.type === 'blur') {
      if (state.focusedWindowId === this.id) state.focusedWindowId = null;
      this.emit('blur');
      return;
    }
    if (event.type === 'bounds-changed') {
      const bounds = event.bounds && typeof event.bounds === 'object' ? event.bounds : {};
      for (const key of ['x', 'y', 'width', 'height']) {
        const value = Number(bounds[key]);
        if (Number.isFinite(value)) this._bounds[key] = value;
      }
      if (event.reason === 'move') this.emit('move');
      if (event.reason === 'resize') this.emit('resize');
      return;
    }
    if (event.type === 'minimize') {
      this._minimized = true;
      this.emit('minimize');
      return;
    }
    if (event.type === 'restore') {
      this._minimized = false;
      this.emit('restore');
      return;
    }
    if (event.type === 'did-start-loading') {
      if (event.url) this._currentUrl = String(event.url);
      this.webContents.emit('did-start-loading');
      return;
    }
    if (event.type === 'did-finish-load') {
      this._notifyDidFinishLoad(event.url || this._currentUrl, 'native');
      return;
    }
    if (event.type === 'did-fail-load') {
      const description = event.error ? String(event.error) : 'Navigation failed';
      this.webContents.emit('did-fail-load', {}, -2, description, event.url || this._currentUrl, true);
      return;
    }
    if (event.type === 'page-title-updated' && event.title) {
      this.options.title = String(event.title);
      this.emit('page-title-updated', { preventDefault() {} }, this.options.title, false);
    }
  }

  _notifyDidFinishLoad(url, source) {
    const href = url ? String(url) : this._currentUrl;
    if (href) this._currentUrl = href;

    const now = Date.now();
    if (
      this._lastFinishedLoad &&
      this._lastFinishedLoad.url === this._currentUrl &&
      this._lastFinishedLoad.source !== source &&
      now - this._lastFinishedLoad.time < 300
    ) {
      return;
    }
    this._lastFinishedLoad = { url: this._currentUrl, time: now, source };

    const firstLoad = !this._rendererReady;
    this._rendererReady = true;
    this.webContents.emit('dom-ready');
    this.webContents.emit('did-finish-load');
    this.webContents.emit('did-stop-loading');

    if (firstLoad) {
      this.emit('ready-to-show');
      if (this.options.show) this.emit('show');
    }
  }

  _finalizeClosed(details) {
    if (this._destroyed) return;
    this._destroyed = true;
    this._hostAttached = false;
    if (state.focusedWindowId === this.id) state.focusedWindowId = null;
    if (this._parent) this._parent._children.delete(this);
    for (const child of this._children) child._parent = null;
    this._children.clear();
    state.windows.delete(this.id);
    this.emit('closed', details);
    if (state.windows.size === 0 && !state.isQuitting) app.emit('window-all-closed');
  }

  show() {
    this._visible = true;
    this._sendHostCommand({ command: 'show' });
    this.emit('show');
  }

  hide() {
    this._visible = false;
    if (!this._sendHostCommand({ command: 'hide' })) {
      console.warn('[AtomJS] Native hide is not supported by the current platform host.');
    }
    this.emit('hide');
  }

  isVisible() {
    return this._visible && !this._destroyed;
  }

  focus() {
    if (!this._sendHostCommand({ command: 'focus' })) {
      console.warn('[AtomJS] Native focus is not supported by the current platform host.');
    }
  }

  startDrag() {
    if (!this._startNativeDrag()) {
      console.warn('[AtomJS] Native window dragging is not supported by the current platform host.');
    }
  }

  blur() {}

  close() {
    if (this._destroyed) return;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', event);
    if (event.defaultPrevented) return;

    if (this._sendHostCommand({ command: 'close' })) return;
    state.bridgeServer && state.bridgeServer.send(this.id, { type: 'system', command: 'close' });
    setTimeout(() => {
      if (!this._destroyed && this._child) this._child.kill();
    }, 800).unref();
  }

  destroy() {
    if (this._destroyed) return;
    if (this._nativeHost) {
      try { this._sendHostCommand({ command: 'destroy' }); } catch {}
    }
    if (this._child) {
      try { this._child.kill(); } catch {}
      this._child = null;
    }
    this._finalizeClosed({ code: 0, signal: null });
  }

  isDestroyed() {
    return this._destroyed;
  }

  setTitle(title) {
    this.options.title = String(title);
    if (!this._sendHostCommand({ command: 'set-title', title: this.options.title }) && state.bridgeServer) {
      state.bridgeServer.send(this.id, { type: 'system', command: 'set-title', title: this.options.title });
    }
  }

  getTitle() {
    return this.options.title || app.getName();
  }

  getParentWindow() {
    return this._parent && !this._parent.isDestroyed() ? this._parent : null;
  }

  getChildWindows() {
    return [...this._children].filter((child) => !child.isDestroyed());
  }

  setMenu(menu) {
    this._menu = menu || null;
    return this;
  }

  getMenu() {
    return this._menu;
  }

  removeMenu() {
    this._menu = null;
  }

  setMenuBarVisibility(visible) {
    this._menuBarVisible = Boolean(visible);
  }

  isMenuBarVisible() {
    return this._menuBarVisible;
  }

  autoHideMenuBar() {
    return false;
  }

  setAutoHideMenuBar() {}

  isFullScreen() {
    return this._fullScreen;
  }

  setAlwaysOnTop(value = true) {
    this._alwaysOnTop = Boolean(value);
    this.options.alwaysOnTop = this._alwaysOnTop;
    if (!this._sendHostCommand({ command: 'set-always-on-top', value: this._alwaysOnTop })) {
      console.warn('[AtomJS] Changing always-on-top after creation is not supported by the current platform host. Set alwaysOnTop in BrowserWindow options.');
    }
  }

  isAlwaysOnTop() {
    return this._alwaysOnTop;
  }

  setOpacity(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw new TypeError('BrowserWindow.setOpacity expects a number between 0 and 1.');
    }
    this._opacity = number;
    this.options.opacity = number;
    if (!this._sendHostCommand({ command: 'set-opacity', value: number })) {
      console.warn('[AtomJS] Changing opacity after creation is not supported by the current platform host. Set opacity in BrowserWindow options.');
    }
  }

  getOpacity() {
    return this._opacity;
  }

  setResizable(value) {
    this.options.resizable = Boolean(value);
    if (!this._sendHostCommand({ command: 'set-resizable', value: this.options.resizable })) {
      console.warn('[AtomJS] Changing resizable after creation is not supported by the current platform host.');
    }
  }

  isResizable() {
    return this.options.resizable;
  }

  isModal() {
    return this.options.modal;
  }

  setFullScreen(value = true) {
    this._fullScreen = Boolean(value);
    if (!this._sendHostCommand({ command: 'fullscreen', value: this._fullScreen })) {
      console.warn('[AtomJS] Native fullscreen switching is not supported by the current platform host.');
    }
  }

  maximize() {
    this._maximized = true;
    if (!this._sendHostCommand({ command: 'maximize' })) {
      console.warn('[AtomJS] Native maximize is not supported by the current platform host.');
    }
  }

  unmaximize() {
    this._maximized = false;
    this._sendHostCommand({ command: 'unmaximize' });
  }

  isMaximized() {
    return this._maximized;
  }

  minimize() {
    this._minimized = true;
    if (!this._sendHostCommand({ command: 'minimize' })) {
      console.warn('[AtomJS] Native minimize is not supported by the current platform host.');
    }
  }

  restore() {
    this._minimized = false;
    this._sendHostCommand({ command: 'restore' });
  }

  isMinimized() {
    return this._minimized;
  }

  setSize(width, height) {
    this.setBounds({ width, height });
  }

  getSize() {
    return [this._bounds.width, this._bounds.height];
  }

  setBounds(bounds) {
    const next = { ...this._bounds };
    for (const key of ['x', 'y', 'width', 'height']) {
      if (Number.isFinite(Number(bounds?.[key]))) next[key] = Number(bounds[key]);
    }
    this._bounds = next;
    if (!this._sendHostCommand({ command: 'set-bounds', bounds: next })) {
      console.warn('[AtomJS] Changing native bounds is not supported by the current platform host.');
    }
  }

  getBounds() {
    return { ...this._bounds };
  }

  reload() {
    this.webContents.reload();
  }

  static getAllWindows() {
    return [...state.windows.values()].filter((win) => !win.isDestroyed());
  }

  static fromId(id) {
    return state.windows.get(Number(id)) || null;
  }

  static getFocusedWindow() {
    if (state.focusedWindowId != null) {
      const focused = BrowserWindow.fromId(state.focusedWindowId);
      if (focused && !focused.isDestroyed()) return focused;
    }
    const windows = BrowserWindow.getAllWindows();
    return windows.length ? windows[windows.length - 1] : null;
  }
}

function attachHostOutput(win, child) {
  if (!child.stdout) return;
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      handleHostLine(win, line);
    }
  });
  child.stdout.on('end', () => {
    if (pending) handleHostLine(win, pending);
  });
}

function handleHostLine(win, line) {
  const prefix = '__ATOMJS_EVENT__';
  if (!line.startsWith(prefix)) {
    if (line) process.stdout.write(`${line}\n`);
    return;
  }
  try {
    win._handleHostEvent(JSON.parse(line.slice(prefix.length)));
  } catch (error) {
    console.warn('[AtomJS] Invalid window-host event:', error.message);
  }
}

function normalizeOptions(options) {
  return {
    width: finiteOr(options.width, 800),
    height: finiteOr(options.height, 600),
    x: finiteOrNull(options.x),
    y: finiteOrNull(options.y),
    title: options.title ? String(options.title) : '',
    show: options.show !== false,
    resizable: options.resizable !== false,
    modal: options.modal === true,
    alwaysOnTop: options.alwaysOnTop === true,
    focusable: options.focusable !== false,
    closable: options.closable !== false,
    minimizable: options.minimizable !== false,
    maximizable: options.maximizable !== false,
    fullscreenable: options.fullscreenable !== false,
    skipTaskbar: options.skipTaskbar === true,
    transparent: options.transparent === true,
    opacity: clampOpacity(options.opacity),
    titleBarStyle: normalizeTitleBarStyle(options.titleBarStyle),
    trafficLightPosition: normalizePoint(options.trafficLightPosition),
    minWidth: finiteOrZero(options.minWidth),
    minHeight: finiteOrZero(options.minHeight),
    maxWidth: finiteOrZero(options.maxWidth),
    maxHeight: finiteOrZero(options.maxHeight),
    center: options.center !== false,
    frame: options.frame !== false,
    backgroundColor: options.backgroundColor || '#ffffff',
    webPreferences: {
      preload: options.webPreferences && options.webPreferences.preload
        ? path.resolve(options.webPreferences.preload)
        : null,
      contextIsolation: options.webPreferences ? options.webPreferences.contextIsolation !== false : true,
      nodeIntegration: false,
      devTools: options.webPreferences ? options.webPreferences.devTools !== false : true
    }
  };
}

function clampOpacity(value) {
  if (value == null) return 1;
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizePoint(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function normalizeTitleBarStyle(value) {
  const normalized = String(value || 'default');
  return ['default', 'hidden', 'hiddenInset', 'customButtonsOnHover'].includes(normalized)
    ? normalized
    : 'default';
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

module.exports = { BrowserWindow };
