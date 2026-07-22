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

test('renderer bridge maps Electron-style app regions to native drag-region updates', () => {
  const script = generateBridgeScript({
    websocketUrl: 'ws://127.0.0.1:1234/__atom/ws',
    preloadCode: ''
  });
  assert.match(script, /-webkit-app-region/);
  assert.match(script, /data-atom-drag-region/);
  assert.match(script, /data-atom-no-drag/);
  assert.match(script, /command: 'set-window-drag-regions'/);
  assert.doesNotMatch(script, /setBounds/);
});

test('bridge serves files and handles invoke IPC', async (t) => {
  await atom.app.whenReady();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-test-'));
  fs.mkdirSync(path.join(temp, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'index.html'), '<link rel="stylesheet" href="/assets/app.css"><h1>hello</h1>');
  fs.writeFileSync(path.join(temp, 'assets', 'app.css'), 'h1 { font-weight: 700; }');

  const win = new atom.BrowserWindow({ show: false });
  win._contentRoot = temp;
  const fileUrl = state.bridgeServer.fileUrl(win.id, 'index.html');
  const response = await fetch(fileUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>hello<\/h1>/);

  const rootRelativeAssetUrl = new URL('/assets/app.css', fileUrl);
  const assetResponse = await fetch(rootRelativeAssetUrl, { headers: { referer: fileUrl } });
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.url, new RegExp(`/__atom/window/${win.id}/assets/app\\.css$`));
  assert.equal(await assetResponse.text(), 'h1 { font-weight: 700; }');

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

test('ships one native macOS WKWebView host without osascript', () => {
  const runtimeRoot = path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'runtime');
  const legacyHost = fs.readFileSync(path.join(runtimeRoot, 'window-host.mjs'), 'utf8');
  const nativeHost = fs.readFileSync(path.join(runtimeRoot, 'macos-native-host.m'), 'utf8');
  const manager = fs.readFileSync(path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'native-host.cjs'), 'utf8');

  assert.doesNotMatch(legacyHost, /osascript/);
  assert.match(nativeHost, /WKWebView/);
  assert.match(nativeHost, /WKUserScriptInjectionTimeAtDocumentStart/);
  assert.match(nativeHost, /NSMutableDictionary<NSNumber \*, AtomJSWindowController \*>/);
  assert.match(manager, /let singleton = null/);
  assert.match(manager, /command: 'create'/);
});

test('macOS builds embed the project payload and produce a real app bundle', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  assert.match(build, /assets: \{ 'atom-app': payloadPath \}/);
  assert.match(build, /getAsset\('atom-app'\)/);
  assert.match(build, /AtomJSWindowHost/);
  assert.match(build, /codesign[\s\S]*--verify[\s\S]*--deep[\s\S]*--strict/);
  assert.doesNotMatch(build, /Resources', 'app'/);
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

test('BrowserWindow supports parent/modal relationships and customizable native options', () => {
  const parent = new atom.BrowserWindow({ show: false, title: 'Parent' });
  state.focusedWindowId = parent.id;
  const child = new atom.BrowserWindow({
    show: false,
    modal: true,
    alwaysOnTop: true,
    opacity: 0.85,
    resizable: false,
    frame: false,
    transparent: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    minWidth: 420,
    minHeight: 320,
    maxWidth: 900,
    maxHeight: 700
  });

  assert.equal(child.getParentWindow(), parent);
  assert.deepEqual(parent.getChildWindows(), [child]);
  assert.equal(child.isModal(), true);
  assert.equal(child.isAlwaysOnTop(), true);
  assert.equal(child.getOpacity(), 0.85);
  assert.equal(child.isResizable(), false);

  child._nativeHost = { send() {} };
  child.setOpacity(0.6);
  child.setAlwaysOnTop(false);
  child.setResizable(true);
  assert.equal(child.getOpacity(), 0.6);
  assert.equal(child.isAlwaysOnTop(), false);
  assert.equal(child.isResizable(), true);

  child.destroy();
  parent.destroy();
  state.focusedWindowId = null;
});

test('Windows host activates OAuth windows and supports native ownership', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'runtime', 'window-host.mjs'),
    'utf8'
  );
  assert.match(source, /GWLP_HWNDPARENT/);
  assert.match(source, /EnableWindow\(\$parent, \$false\)/);
  assert.match(source, /AttachThreadInput/);
  assert.match(source, /GetForegroundWindow/);
  assert.match(source, /SetActiveWindow\(\$child\)/);
  assert.match(source, /SetForegroundWindow\(\$child\)/);
  assert.match(source, /windowsHide: true/);
});

test('BrowserWindow starts one native drag operation instead of renderer-driven movement', () => {
  const win = new atom.BrowserWindow({ show: false, frame: false });
  const messages = [];
  win._nativeHost = { send(message) { messages.push(message); } };

  win.startDrag();

  assert.deepEqual(messages, [{ command: 'start-drag', windowId: win.id }]);
  win.destroy();
});

test('macOS custom title bars use AppKit native window dragging', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'runtime', 'macos-native-host.m'),
    'utf8'
  );
  const bridgeServer = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'bridge-server.cjs'),
    'utf8'
  );

  assert.match(source, /performWindowDragWithEvent/);
  assert.match(source, /performWindowDragWithEvent:event/);
  assert.match(source, /command isEqualToString:@"start-drag"/);
  assert.match(bridgeServer, /message\.command === 'set-window-drag-regions'/);
});

test('macOS host maps modal, title-bar and visual options to AppKit', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'runtime', 'macos-native-host.m'),
    'utf8'
  );
  assert.match(source, /beginSheet:_window/);
  assert.match(source, /addChildWindow:_window ordered:NSWindowAbove/);
  assert.match(source, /NSFloatingWindowLevel/);
  assert.match(source, /titlebarAppearsTransparent/);
  assert.match(source, /trafficLightPosition/);
  assert.doesNotMatch(source, /\.drawsBackground\s*=/);
  assert.match(source, /setValue:@NO forKey:@"drawsBackground"/);
  assert.match(source, /underPageBackgroundColor/);
  assert.match(source, /set-always-on-top/);
  assert.match(source, /set-opacity/);
  assert.match(source, /set-resizable/);
});


test('Windows uses one in-process prebuilt native host instead of one Node helper per window', () => {
  const browserWindow = fs.readFileSync(path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'browser-window.cjs'), 'utf8');
  const windowsHost = fs.readFileSync(path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'windows-native-host.cjs'), 'utf8');

  assert.match(browserWindow, /process\.platform === 'win32'[\s\S]*getWindowsNativeHost\(\)/);
  assert.match(windowsHost, /require\('@webviewjs\/webview'\)/);
  assert.match(windowsHost, /new binding\.Application/);
  assert.match(windowsHost, /createWebContext/);
  assert.match(windowsHost, /dataDirectory: this\.webviewDataDirectory/);
  assert.match(windowsHost, /logical: true/);
  assert.match(windowsHost, /case 'set-drag-regions'/);
  assert.match(windowsHost, /case 'start-drag'/);
  assert.doesNotMatch(windowsHost, /child_process|spawn\(/);
});
