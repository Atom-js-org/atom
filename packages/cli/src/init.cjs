'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fse = require('fs-extra');

async function initCommand(directory, options = {}) {
  const root = path.resolve(directory);
  await fse.ensureDir(root);
  const existing = await fs.promises.readdir(root);
  if (existing.length > 0 && !existing.every((name) => name === '.git')) {
    throw new Error(`Directory is not empty: ${root}`);
  }

  const packageName = sanitizePackageName(options.name || path.basename(root));
  const productName = humanize(packageName);

  await fse.ensureDir(path.join(root, 'src'));
  await fse.ensureDir(path.join(root, '.github', 'workflows'));

  await fs.promises.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: packageName,
    version: '0.1.0',
    private: true,
    main: 'src/main.js',
    scripts: {
      dev: 'atom run dev',
      build: 'atom build all',
      'build:current': `atom build ${hostTarget()}`,
      start: 'atom run build'
    },
    dependencies: {
      '@atom-js-org/runtime': '0.4.3-alpha.0',
      electron: 'npm:@atom-js-org/electron@0.4.3-alpha.0'
    },
    optionalDependencies: {
      'webview-nodejs': '0.5.0'
    },
    devDependencies: {
      '@atom-js-org/cli': '0.4.3-alpha.0'
    },
    overrides: {
      tar: '7.5.20'
    }
  }, null, 2));

  await fs.promises.writeFile(path.join(root, 'atom.config.json'), JSON.stringify({
    appId: `com.example.${packageName.replace(/[^a-z0-9]+/g, '')}`,
    productName,
    main: 'src/main.js',
    icon: 'assets/icon.png',
    installerCredit: true,
    github: {
      workflow: 'atom-build.yml'
    }
  }, null, 2));

  await fse.ensureDir(path.join(root, 'assets'));
  await fs.promises.writeFile(path.join(root, 'src', 'main.js'), mainTemplate());
  await fs.promises.writeFile(path.join(root, 'src', 'preload.js'), preloadTemplate());
  await fs.promises.writeFile(path.join(root, 'src', 'index.html'), htmlTemplate(productName));
  await fs.promises.writeFile(path.join(root, 'src', 'renderer.js'), rendererTemplate());
  await fs.promises.writeFile(path.join(root, '.gitignore'), 'node_modules/\nbuild/\n.atom/\n');
  await fs.promises.writeFile(path.join(root, '.github', 'workflows', 'atom-build.yml'), workflowTemplate());

  console.log(`Created AtomJS project in ${root}`);
  console.log('Next: npm install && npm run dev');
}

function mainTemplate() {
  return `'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: app.getName(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (result.canceled) return null;
  return {
    path: result.filePaths[0],
    content: await fs.readFile(result.filePaths[0], 'utf8')
  };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
`;
}

function preloadTemplate() {
  return `'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atom', {
  openFile: () => ipcRenderer.invoke('file:open'),
  onMessage: (listener) => ipcRenderer.on('app:message', (_event, message) => listener(message))
});
`;
}

function htmlTemplate(productName) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(productName)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #202124; color: #f5f7fb; }
    main { width: min(720px, calc(100% - 48px)); }
    h1 { font-size: clamp(2.5rem, 8vw, 5rem); margin: 0 0 12px; }
    p { color: #aeb8c8; font-size: 1.1rem; }
    button { border: 0; border-radius: 10px; padding: 12px 18px; font: inherit; cursor: pointer; background: #7ddff2; color: #14202a; font-weight: 700; }
    pre { min-height: 160px; overflow: auto; padding: 18px; border-radius: 12px; background: #17181a; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(productName)}</h1>
    <p>Fast, lightweight desktop UI powered by the system WebView.</p>
    <button id="open">Open a text file</button>
    <pre id="output">Ready.</pre>
  </main>
  <script src="renderer.js"></script>
</body>
</html>
`;
}

function rendererTemplate() {
  return `document.querySelector('#open').addEventListener('click', async () => {
  const result = await window.atom.openFile();
  document.querySelector('#output').textContent = result ? result.content : 'Cancelled.';
});
`;
}

function workflowTemplate() {
  return `name: AtomJS Build

on:
  workflow_dispatch:
    inputs:
      target:
        description: windows, macos, linux, or all
        required: true
        default: all
        type: choice
        options: [all, windows, macos, linux]
      project:
        description: Project directory inside the repository
        required: true
        default: .

jobs:
  windows:
    if: inputs.target == 'all' || inputs.target == 'windows'
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: choco install nsis -y
      - run: npm ci
        working-directory: \${{ inputs.project }}
      - run: npx atom build windows --local
        working-directory: \${{ inputs.project }}
      - uses: actions/upload-artifact@v4
        with:
          name: atom-build-windows
          path: \${{ inputs.project }}/build/windows
          if-no-files-found: error

  macos:
    if: inputs.target == 'all' || inputs.target == 'macos'
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
        working-directory: \${{ inputs.project }}
      - run: npx atom build macos --local
        working-directory: \${{ inputs.project }}
      - uses: actions/upload-artifact@v4
        with:
          name: atom-build-macos
          path: \${{ inputs.project }}/build/macos
          if-no-files-found: error

  linux:
    if: inputs.target == 'all' || inputs.target == 'linux'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev zenity
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: |
          sudo curl -L -o /usr/local/bin/appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
          sudo chmod +x /usr/local/bin/appimagetool
      - run: npm ci
        working-directory: \${{ inputs.project }}
      - run: npx atom build linux --local
        working-directory: \${{ inputs.project }}
        env:
          APPIMAGE_EXTRACT_AND_RUN: '1'
      - uses: actions/upload-artifact@v4
        with:
          name: atom-build-linux
          path: \${{ inputs.project }}/build/linux
          if-no-files-found: error
`;
}

function sanitizePackageName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'atomjs-app';
}

function humanize(value) {
  return String(value).split(/[-_.]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function hostTarget() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

module.exports = { initCommand };
