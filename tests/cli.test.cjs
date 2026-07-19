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

test('macOS embedded payload dereferences directory symlinks', async () => {
  const zlib = require('node:zlib');
  const { createApplicationPayload } = require('../packages/cli/src/build.cjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-payload-'));
  const appRoot = path.join(tempRoot, 'app');
  const packageRoot = path.join(appRoot, 'vendor', 'runtime');
  const linkedRoot = path.join(appRoot, 'node_modules', '@atom-js-org', 'runtime');
  const output = path.join(tempRoot, 'payload.gz');

  fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@atom-js-org/runtime"}');
  fs.writeFileSync(path.join(packageRoot, 'src', 'index.cjs'), 'module.exports = 1;');
  fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
  fs.symlinkSync(packageRoot, linkedRoot, 'dir');

  await createApplicationPayload(appRoot, output);
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(output)).toString('utf8'));
  const paths = new Set(archive.files.map((entry) => entry.path));

  assert.ok(paths.has('node_modules/@atom-js-org/runtime/package.json'));
  assert.ok(paths.has('node_modules/@atom-js-org/runtime/src/index.cjs'));

  fs.rmSync(tempRoot, { recursive: true, force: true });
});


test('Windows release packaging uses a GUI PE executable and official WebView2 detection', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  const doctorSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'doctor.cjs'), 'utf8');

  assert.match(buildSource, /writeUInt16LE\(2, pe\.optionalHeaderOffset \+ 68\)/);
  assert.match(buildSource, /certificateDirectory = pe\.dataDirectoryOffset \+ \(8 \* 4\)/);
  assert.match(buildSource, /WriteRegStr HKCU/);
  assert.match(doctorSource, /F3017226-FE2A-4295-8BDF-00C3A9A7E4C5/);
  assert.match(doctorSource, /Get-ItemPropertyValue[^\n]+-Name 'pv'/);
  assert.doesNotMatch(doctorSource, /F1E7E4A4-BD05-43A5-BCC0-B7F5E0E9D7F5/);
});

test('Windows PE parser accepts a real PE signature without escaped-text confusion', () => {
  const { readPortableExecutableLayout } = require('../packages/cli/src/build.cjs');
  const image = Buffer.alloc(0x200);
  image.write('MZ', 0, 'ascii');
  image.writeUInt32LE(0x80, 0x3c);
  image.writeUInt32LE(0x00004550, 0x80);
  image.writeUInt16LE(0x00f0, 0x80 + 20);
  image.writeUInt16LE(0x020b, 0x80 + 24);

  assert.deepEqual(readPortableExecutableLayout(image), {
    optionalHeaderOffset: 0x80 + 24,
    dataDirectoryOffset: 0x80 + 24 + 112
  });

  image.writeUInt32LE(0x00584550, 0x80);
  assert.throws(() => readPortableExecutableLayout(image), /PE header is invalid/);
});

test('macOS native host waits for AppKit readiness and carries application identity', () => {
  const nativeManager = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'native-host.cjs'),
    'utf8'
  );
  const nativeSource = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'atomjs', 'src', 'runtime', 'macos-native-host.m'),
    'utf8'
  );
  const runSource = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'cli', 'src', 'run.cjs'),
    'utf8'
  );

  assert.match(nativeManager, /await this\.request\(\{\s*command: 'create'/s);
  assert.match(nativeManager, /`\$\{executableName\}\.app`/);
  assert.match(nativeManager, /--app-icon/);
  assert.match(nativeSource, /applicationDidFinishLaunching/);
  assert.match(nativeSource, /read\(STDIN_FILENO/);
  assert.match(nativeSource, /setProcessName:atomAppName/);
  assert.match(nativeSource, /application\.applicationIconImage/);
  assert.match(nativeSource, /AtomJSRespond\(requestId, YES, @\{ @"windowId": windowId \}, nil\)/);
  assert.match(runSource, /ATOM_APP_NAME: project\.config\.productName/);
  assert.match(runSource, /ATOM_APP_ID: project\.config\.appId/);
});

test('macOS build uses the system codesign executable instead of an unsupported version probe', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  const doctorSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'doctor.cjs'), 'utf8');

  assert.match(buildSource, /function hasMacCodeSigningTool\(\)/);
  assert.match(buildSource, /fs\.existsSync\('\/usr\/bin\/codesign'\)/);
  assert.doesNotMatch(buildSource, /codesign[^\n]+--version/);
  assert.match(doctorSource, /fs\.existsSync\('\/usr\/bin\/codesign'\)/);
  assert.doesNotMatch(doctorSource, /codesign[^\n]+--version/);
});
