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

class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = state.nextWindowId++;
    this.options = normalizeOptions(options);
    this.webContents = new WebContents(this);
    this._child = null;
    this._destroyed = false;
    this._rendererReady = false;
    this._visible = this.options.show;
    this._contentRoot = null;
    this._currentUrl = '';
    this._pendingLoad = null;
    this._menu = null;
    this._menuBarVisible = true;
    this._lastFinishedLoad = null;
    state.windows.set(this.id, this);
  }

  loadFile(filePath) {
    const task = this._loadFile(filePath);
    // Electron applications commonly call loadFile() without awaiting it. Keep
    // failures observable to callers while preventing a second, unhandled
    // rejection from terminating modern Node.js processes.
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
    this._currentUrl = url;

    if (this._child) {
      state.bridgeServer.send(this.id, { type: 'system', command: 'navigate', url });
      return;
    }

    const preloadPath = this.options.webPreferences.preload;
    let preloadCode = '';
    if (preloadPath) {
      preloadCode = await fs.promises.readFile(path.resolve(preloadPath), 'utf8');
    }

    const config = {
      title: this.options.title || app.getName(),
      width: this.options.width,
      height: this.options.height,
      resizable: this.options.resizable,
      debug: Boolean(this.options.webPreferences.devTools || process.env.ATOM_DEV === '1'),
      url,
      bridgeScript: generateBridgeScript({
        websocketUrl: state.bridgeServer.websocketUrl(this.id),
        preloadCode
      })
    };

    const configPath = path.join(os.tmpdir(), `atomjs-window-${process.pid}-${this.id}-${Date.now()}.json`);
    await fs.promises.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    const hostPath = path.join(__dirname, 'runtime', 'window-host.mjs');
    const nodeExecutable = process.env.ATOM_NODE_EXECUTABLE || process.execPath;
    this._child = spawn(nodeExecutable, [hostPath, configPath], {
      cwd: state.projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit']
    });

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
          this.webContents.emit('did-fail-load', {}, code || 1, 'AtomJS window host exited before the renderer became ready', this._currentUrl, true);
        }
        this._destroyed = true;
        state.windows.delete(this.id);
        this.emit('closed', { code, signal });
        if (state.windows.size === 0 && !state.isQuitting) app.emit('window-all-closed');
      }
    });

    this._pendingLoad = new Promise((resolve, reject) => {
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

    // Keep Electron-style fire-and-forget loadFile() usage from producing an
    // unhandled rejection while still returning the rejecting promise to callers.
    this._pendingLoad.catch(() => {});
    return this._pendingLoad;
  }

  _markRendererReady(details) {
    this._notifyDidFinishLoad(details && details.href ? details.href : this._currentUrl, 'bridge');
  }

  _handleHostEvent(event) {
    if (!event || typeof event !== 'object') return;
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
    if (this._lastFinishedLoad &&
        this._lastFinishedLoad.url === this._currentUrl &&
        this._lastFinishedLoad.source !== source &&
        now - this._lastFinishedLoad.time < 300) {
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

  show() {
    this._visible = true;
    this.emit('show');
  }

  hide() {
    this._visible = false;
    console.warn('[AtomJS] Native hide/show is not yet supported by the current pure-JS window host.');
    this.emit('hide');
  }

  isVisible() {
    return this._visible && !this._destroyed;
  }

  focus() {
    console.warn('[AtomJS] Native focus is not yet supported by the current window host.');
  }

  blur() {}

  close() {
    if (this._destroyed) return;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', event);
    if (event.defaultPrevented) return;
    state.bridgeServer && state.bridgeServer.send(this.id, { type: 'system', command: 'close' });
    setTimeout(() => {
      if (!this._destroyed && this._child) this._child.kill();
    }, 800).unref();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    state.windows.delete(this.id);
    if (this._child) {
      try { this._child.kill(); } catch {}
      this._child = null;
    }
    this.emit('closed');
  }

  isDestroyed() {
    return this._destroyed;
  }

  setTitle(title) {
    this.options.title = String(title);
    if (state.bridgeServer) {
      state.bridgeServer.send(this.id, { type: 'system', command: 'set-title', title: this.options.title });
    }
  }

  getTitle() {
    return this.options.title || app.getName();
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
    return false;
  }

  setFullScreen() {
    console.warn('[AtomJS] Native fullscreen switching is not implemented yet.');
  }

  maximize() {
    console.warn('[AtomJS] Native maximize is not implemented yet.');
  }

  unmaximize() {}

  isMaximized() {
    return false;
  }

  minimize() {
    console.warn('[AtomJS] Native minimize is not implemented yet.');
  }

  restore() {}

  isMinimized() {
    return false;
  }

  setSize(width, height) {
    this.options.width = Number(width);
    this.options.height = Number(height);
    console.warn('[AtomJS] Changing the native window size after creation is not yet supported.');
  }

  getSize() {
    return [this.options.width, this.options.height];
  }

  setBounds(bounds) {
    if (bounds.width) this.options.width = Number(bounds.width);
    if (bounds.height) this.options.height = Number(bounds.height);
    console.warn('[AtomJS] Changing native bounds after creation is not yet supported.');
  }

  getBounds() {
    return { x: 0, y: 0, width: this.options.width, height: this.options.height };
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
    if (line) process.stdout.write(line + '\n');
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
    title: options.title ? String(options.title) : '',
    show: options.show !== false,
    resizable: options.resizable !== false,
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

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

module.exports = { BrowserWindow };
