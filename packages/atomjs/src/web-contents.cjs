'use strict';

const { EventEmitter } = require('node:events');
const state = require('./state.cjs');

class WebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.id = owner.id;
  }

  send(channel, ...args) {
    ensureAlive(this.owner);
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('webContents.send channel must be a non-empty string');
    }
    state.bridgeServer.send(this.owner.id, { type: 'event', channel, args });
  }

  executeJavaScript(code, _userGesture = false) {
    ensureAlive(this.owner);
    return state.bridgeServer.executeJavaScript(this.owner.id, String(code));
  }

  reload() {
    ensureAlive(this.owner);
    if (!this.owner._sendHostCommand({ command: 'reload' })) {
      state.bridgeServer.send(this.owner.id, { type: 'system', command: 'reload' });
    }
  }

  loadURL(url) {
    ensureAlive(this.owner);
    const value = String(url);
    this.owner._currentUrl = value;
    if (!this.owner._sendHostCommand({ command: 'navigate', url: value })) {
      state.bridgeServer.send(this.owner.id, { type: 'system', command: 'navigate', url: value });
    }
  }

  openDevTools() {
    console.warn('[AtomJS] DevTools must currently be enabled with webPreferences.devTools before the window starts.');
  }

  closeDevTools() {}

  isDevToolsOpened() {
    return false;
  }

  getURL() {
    return this.owner._currentUrl || '';
  }

  isDestroyed() {
    return this.owner.isDestroyed();
  }
}

function ensureAlive(owner) {
  if (!owner || owner.isDestroyed()) throw new Error('Object has been destroyed');
}

module.exports = { WebContents };
