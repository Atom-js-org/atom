'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { WebSocketServer, WebSocket } = require('ws');
const state = require('./state.cjs');
const ipcMain = require('./ipc-main.cjs');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8']
]);

class BridgeServer {
  constructor() {
    this.server = null;
    this.wss = null;
    this.port = null;
    this.token = crypto.randomBytes(32).toString('hex');
    this.sockets = new Map();
    this.pendingExecutions = new Map();
  }

  async start() {
    if (this.server) return;

    this.server = http.createServer((request, response) => {
      this._handleHttp(request, response).catch((error) => {
        response.statusCode = 500;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(`AtomJS bridge error: ${error.message}`);
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const windowId = Number(url.searchParams.get('windowId'));
        const token = url.searchParams.get('token');
        if (url.pathname !== '/__atom/ws' || token !== this.token || !state.windows.has(windowId)) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(request, socket, head, (websocket) => {
          this.wss.emit('connection', websocket, request, windowId);
        });
      } catch {
        socket.destroy();
      }
    });

    this.wss.on('connection', (socket, _request, windowId) => {
      const previous = this.sockets.get(windowId);
      if (previous && previous.readyState === WebSocket.OPEN) previous.close();
      this.sockets.set(windowId, socket);

      socket.on('message', (raw) => {
        this._handleRendererMessage(windowId, raw).catch((error) => {
          console.error('[AtomJS bridge message error]', error);
        });
      });

      socket.on('close', () => {
        if (this.sockets.get(windowId) === socket) this.sockets.delete(windowId);
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        this.port = address.port;
        resolve();
      });
    });
  }

  async stop() {
    for (const socket of this.sockets.values()) {
      try { socket.close(); } catch {}
    }
    this.sockets.clear();
    if (this.wss) this.wss.close();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
    this.server = null;
    this.wss = null;
    this.port = null;
  }

  websocketUrl(windowId) {
    if (!this.port) throw new Error('AtomJS bridge server is not running');
    const query = new URLSearchParams({ windowId: String(windowId), token: this.token });
    return `ws://127.0.0.1:${this.port}/__atom/ws?${query}`;
  }

  fileUrl(windowId, relativePath) {
    if (!this.port) throw new Error('AtomJS bridge server is not running');
    const normalized = String(relativePath).split(path.sep).map(encodeURIComponent).join('/');
    return `http://127.0.0.1:${this.port}/__atom/window/${windowId}/${normalized}`;
  }

  send(windowId, message) {
    const socket = this.sockets.get(windowId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  executeJavaScript(windowId, code, timeoutMs = 30000) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingExecutions.delete(id);
        reject(new Error('executeJavaScript timed out'));
      }, timeoutMs);
      this.pendingExecutions.set(id, { resolve, reject, timeout });
      if (!this.send(windowId, { type: 'system', command: 'execute', id, code })) {
        clearTimeout(timeout);
        this.pendingExecutions.delete(id);
        reject(new Error('Renderer is not connected'));
      }
    });
  }

  async _handleRendererMessage(windowId, raw) {
    const win = state.windows.get(windowId);
    if (!win) return;

    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (message.type === 'renderer-ready') {
      win._markRendererReady(message);
      return;
    }

    if (message.type === 'send') {
      const event = createIpcEvent(win);
      ipcMain.emit(message.channel, event, ...(Array.isArray(message.args) ? message.args : []));
      return;
    }

    if (message.type === 'invoke') {
      const event = createIpcEvent(win);
      try {
        const result = await ipcMain._invoke(message.channel, event, Array.isArray(message.args) ? message.args : []);
        this.send(windowId, { type: 'invoke-result', id: message.id, ok: true, result });
      } catch (error) {
        this.send(windowId, {
          type: 'invoke-result',
          id: message.id,
          ok: false,
          error: serializeError(error)
        });
      }
      return;
    }

    if (message.type === 'execute-result') {
      const pending = this.pendingExecutions.get(message.id);
      if (!pending) return;
      this.pendingExecutions.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error(message.error && message.error.message ? message.error.message : 'Renderer execution failed');
        if (message.error && message.error.stack) error.stack = message.error.stack;
        pending.reject(error);
      }
    }
  }

  async _handleHttp(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname === '/__atom/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, runtime: 'atomjs' }));
      return;
    }

    const match = url.pathname.match(/^\/__atom\/window\/(\d+)\/(.*)$/);
    if (!match) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    const windowId = Number(match[1]);
    const win = state.windows.get(windowId);
    if (!win || !win._contentRoot) {
      response.statusCode = 404;
      response.end('Unknown window');
      return;
    }

    const requested = decodeURIComponent(match[2] || 'index.html');
    const root = path.resolve(win._contentRoot);
    let absolute = path.resolve(root, requested);

    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = await fs.promises.stat(absolute);
      if (stat.isDirectory()) {
        absolute = path.join(absolute, 'index.html');
        stat = await fs.promises.stat(absolute);
      }
    } catch {
      response.statusCode = 404;
      response.end('File not found');
      return;
    }

    if (!stat.isFile()) {
      response.statusCode = 404;
      response.end('File not found');
      return;
    }

    response.statusCode = 200;
    response.setHeader('content-type', MIME_TYPES.get(path.extname(absolute).toLowerCase()) || 'application/octet-stream');
    response.setHeader('content-length', String(stat.size));
    response.setHeader('cache-control', process.env.ATOM_DEV === '1' ? 'no-store' : 'public, max-age=3600');
    response.setHeader('x-content-type-options', 'nosniff');
    fs.createReadStream(absolute).pipe(response);
  }
}

function createIpcEvent(win) {
  return Object.freeze({
    sender: win.webContents,
    senderFrame: null,
    reply(channel, ...args) {
      win.webContents.send(channel, ...args);
    }
  });
}

function serializeError(error) {
  return {
    name: error && error.name ? String(error.name) : 'Error',
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack) : undefined
  };
}

module.exports = { BridgeServer };
