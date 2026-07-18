'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const state = require('./state.cjs');
const { BridgeServer } = require('./bridge-server.cjs');

class App extends EventEmitter {
  constructor() {
    super();
    this._readyPromise = null;
    this._name = readPackageName();
  }

  whenReady() {
    if (!this._readyPromise) {
      this._readyPromise = (async () => {
        state.bridgeServer = new BridgeServer();
        await state.bridgeServer.start();
        queueMicrotask(() => this.emit('ready'));
        return this;
      })();
    }
    return this._readyPromise;
  }

  isReady() {
    return Boolean(this._readyPromise && state.bridgeServer && state.bridgeServer.port);
  }

  async quit() {
    if (state.isQuitting) return;
    state.isQuitting = true;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('before-quit', event);
    if (event.defaultPrevented) {
      state.isQuitting = false;
      return;
    }

    for (const win of [...state.windows.values()]) win.destroy();
    if (state.bridgeServer) await state.bridgeServer.stop();
    this.emit('will-quit');
    this.emit('quit', {}, 0);
  }

  exit(exitCode = 0) {
    for (const win of [...state.windows.values()]) win.destroy();
    process.exit(exitCode);
  }

  getName() {
    return this._name;
  }

  setName(name) {
    this._name = String(name);
  }

  getVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(state.projectRoot, 'package.json'), 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  getAppPath() {
    return state.projectRoot;
  }

  getPath(name) {
    const home = os.homedir();
    const appData = process.platform === 'win32'
      ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));

    const table = {
      home,
      appData,
      userData: path.join(appData, this.getName()),
      temp: os.tmpdir(),
      desktop: path.join(home, 'Desktop'),
      documents: path.join(home, 'Documents'),
      downloads: path.join(home, 'Downloads'),
      music: path.join(home, 'Music'),
      pictures: path.join(home, 'Pictures'),
      videos: path.join(home, 'Videos'),
      logs: path.join(appData, this.getName(), 'logs')
    };

    if (!(name in table)) throw new Error(`Unsupported app path: ${name}`);
    return table[name];
  }
}

function readPackageName() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(state.projectRoot, 'package.json'), 'utf8'));
    return pkg.productName || pkg.name || 'AtomJS App';
  } catch {
    return 'AtomJS App';
  }
}

module.exports = new App();
