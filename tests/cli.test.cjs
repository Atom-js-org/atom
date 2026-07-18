'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProject, validateTarget, hostTarget } = require('../packages/cli/src/utils.cjs');
const { initCommand } = require('../packages/cli/src/init.cjs');

test('build target validation matches the documented CLI', () => {
  assert.equal(validateTarget('windows'), 'windows');
  assert.equal(validateTarget('MACOS'), 'macos');
  assert.equal(validateTarget('all'), 'all');
  assert.ok(['windows', 'macos', 'linux'].includes(hostTarget()));
  assert.throws(() => validateTarget('android'), /Unknown build target/);
});

test('atom init creates Electron-like project structure and workflow', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-init-'));
  const projectRoot = path.join(tempRoot, 'sample-app');
  await initCommand(projectRoot, { name: 'sample-app' });

  const project = loadProject(projectRoot);
  assert.equal(project.config.main, 'src/main.js');
  assert.equal(project.config.productName, 'Sample App');
  assert.ok(fs.existsSync(path.join(projectRoot, 'src', 'preload.js')));
  assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'workflows', 'atom-build.yml')));

  const main = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(projectRoot, 'src', 'preload.js'), 'utf8');
  assert.match(main, /BrowserWindow/);
  assert.match(main, /ipcMain/);
  assert.match(preload, /contextBridge/);
  assert.match(preload, /ipcRenderer/);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('CLI provisions a lightweight electron facade for transitive dependencies', async () => {
  const { ensureElectronCompatibility } = require('../packages/cli/src/electron-compat.cjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-electron-facade-'));
  fs.mkdirSync(path.join(tempRoot, 'node_modules'), { recursive: true });

  const installed = await ensureElectronCompatibility(tempRoot);
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@atom-js-org/electron');
  assert.equal(pkg.atomjsElectronCompatibility, true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
