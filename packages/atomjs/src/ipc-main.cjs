'use strict';

const { EventEmitter } = require('node:events');

class IpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, listener) {
    validateChannel(channel);
    if (typeof listener !== 'function') {
      throw new TypeError('ipcMain.handle listener must be a function');
    }
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this.handlers.set(channel, listener);
  }

  handleOnce(channel, listener) {
    validateChannel(channel);
    const wrapped = async (...args) => {
      this.removeHandler(channel);
      return listener(...args);
    };
    this.handle(channel, wrapped);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  async _invoke(channel, event, args) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No ipcMain handler registered for '${channel}'`);
    }
    return handler(event, ...args);
  }
}

function validateChannel(channel) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new TypeError('IPC channel must be a non-empty string');
  }
}

module.exports = new IpcMain();
