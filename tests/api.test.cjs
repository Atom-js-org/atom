'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const atom = require('../packages/atomjs');
const state = require('../packages/atomjs/src/state.cjs');
const { generateBridgeScript } = require('../packages/atomjs/src/bridge-script.cjs');

test('exports Electron-like main-process names', () => {
  assert.equal(typeof atom.app.whenReady, 'function');
  assert.equal(typeof atom.BrowserWindow, 'function');
  assert.equal(typeof atom.ipcMain.handle, 'function');
  assert.equal(typeof atom.dialog.showOpenDialog, 'function');
});

test('preload bridge exposes contextBridge and ipcRenderer compatibility', () => {
  const script = generateBridgeScript({
    websocketUrl: 'ws://127.0.0.1:1234/__atom/ws',
    preloadCode: "const { contextBridge } = require('@atom-js-org/runtime'); contextBridge.exposeInMainWorld('x', { ok: true });"
  });
  assert.match(script, /contextBridge/);
  assert.match(script, /ipcRenderer/);
  assert.match(script, /AtomJS system-WebView preload/);
});

test('bridge serves files and handles invoke IPC', async (t) => {
  await atom.app.whenReady();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-test-'));
  fs.writeFileSync(path.join(temp, 'index.html'), '<h1>hello</h1>');

  const win = new atom.BrowserWindow({ show: false });
  win._contentRoot = temp;
  const fileUrl = state.bridgeServer.fileUrl(win.id, 'index.html');
  const response = await fetch(fileUrl);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>hello</h1>');

  atom.ipcMain.handle('math:add', (_event, a, b) => a + b);
  const socket = new WebSocket(state.bridgeServer.websocketUrl(win.id));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('IPC test timed out')), 3000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === 'test-1') {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  socket.send(JSON.stringify({ type: 'invoke', id: 'test-1', channel: 'math:add', args: [4, 7] }));
  assert.deepEqual(await result, { type: 'invoke-result', id: 'test-1', ok: true, result: 11 });

  socket.close();
  atom.ipcMain.removeHandler('math:add');
  win.destroy();
  fs.rmSync(temp, { recursive: true, force: true });

  t.after(async () => {
    if (state.bridgeServer) await state.bridgeServer.stop();
  });
});

test('ships a macOS JavaScript WKWebView host without the native binding', () => {
  const runtimeRoot = path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'runtime');
  const host = fs.readFileSync(path.join(runtimeRoot, 'window-host.mjs'), 'utf8');
  const macHost = fs.readFileSync(path.join(runtimeRoot, 'macos-window-host.jxa.js'), 'utf8');
  assert.match(host, /process\.platform === 'darwin'/);
  assert.match(host, /osascript/);
  assert.match(macHost, /WKWebView/);
  assert.match(macHost, /WKUserScriptInjectionTimeAtDocumentStart/);
});

test('public load methods suppress fire-and-forget unhandled rejections', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'browser-window.cjs'), 'utf8');
  assert.match(source, /loadFile\(filePath\)[\s\S]*task\.catch\(\(\) => \{\}\)/);
  assert.match(source, /loadURL\(url\)[\s\S]*task\.catch\(\(\) => \{\}\)/);
});

test('the electron package name resolves to AtomJS for CommonJS and ESM', async () => {
  const commonjs = require('electron');
  const esm = await import('electron');

  assert.equal(commonjs.BrowserWindow, atom.BrowserWindow);
  assert.equal(esm.BrowserWindow, atom.BrowserWindow);
  assert.equal(esm.default.BrowserWindow, atom.BrowserWindow);
  assert.match(process.versions.electron, /atomjs/);
  assert.equal(process.type, 'browser');
});

test('BrowserWindow supports MSMC-style Electron methods and repeated navigation events', () => {
  const win = new atom.BrowserWindow({ show: false });
  let finished = 0;
  win.webContents.on('did-finish-load', () => finished++);

  win.setMenu(null);
  assert.equal(win.getMenu(), null);

  win._markRendererReady({ href: 'https://example.test/login' });
  win._markRendererReady({ href: 'https://example.test/callback?code=ok' });

  assert.equal(finished, 2);
  assert.equal(win.webContents.getURL(), 'https://example.test/callback?code=ok');
  win.destroy();
});

test('preload require accepts the electron module name', () => {
  const script = generateBridgeScript({
    websocketUrl: 'ws://127.0.0.1:1234/__atom/ws',
    preloadCode: "const { contextBridge, ipcRenderer } = require('electron');"
  });
  assert.match(script, /specifier === 'electron'/);
  assert.match(script, /electron\/renderer/);
});
