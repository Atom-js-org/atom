'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProject, validateTarget, hostTarget } = require('../packages/cli/src/utils.cjs');
const { writeArArchive, normalizeDebVersion, normalizeRpmVersion } = require('../packages/cli/src/build.cjs');
const { initCommand } = require('../packages/cli/src/init.cjs');

test('build target validation matches the documented CLI', () => {
  assert.equal(validateTarget('windows'), 'windows');
  assert.equal(validateTarget('MACOS'), 'macos');
  assert.equal(validateTarget('all'), 'all');
  assert.equal(validateTarget('current'), 'current');
  assert.ok(['windows', 'macos', 'linux'].includes(hostTarget()));
  assert.throws(() => validateTarget('android'), /Unknown build target/);
});

test('atom init creates a local-first Electron-like project without requiring GitHub Actions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-init-'));
  const projectRoot = path.join(tempRoot, 'sample-app');
  await initCommand(projectRoot, { name: 'sample-app' });

  const project = loadProject(projectRoot);
  assert.equal(project.config.main, 'src/main.js');
  assert.equal(project.config.productName, 'Sample App');
  assert.ok(fs.existsSync(path.join(projectRoot, 'src', 'preload.js')));
  assert.equal(fs.existsSync(path.join(projectRoot, '.github', 'workflows', 'atom-build.yml')), false);
  const initializedPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(initializedPackage.scripts.build, 'atom build current --local');
  assert.ok(fs.existsSync(path.join(projectRoot, 'assets', 'icon.png')));
  assert.ok(fs.existsSync(path.join(projectRoot, 'assets', 'icon.ico')));
  assert.equal(project.config.build.windows.icon, 'assets/icon.ico');
  assert.equal(project.config.build.macos.icon, 'assets/icon.png');
  assert.equal(project.config.build.linux.deb, true);
  assert.equal(project.config.build.linux.rpm, true);

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
  fs.mkdirSync(path.join(appRoot, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@atom-js-org/runtime"}');
  fs.writeFileSync(path.join(packageRoot, 'src', 'index.cjs'), 'module.exports = 1;');
  fs.writeFileSync(path.join(appRoot, 'src', 'index.html'), '<link rel="stylesheet" href="/src/styles.css"><script src="/src/app.js"></script>');
  fs.writeFileSync(path.join(appRoot, 'src', 'styles.css'), 'body { background: black; }');
  fs.writeFileSync(path.join(appRoot, 'src', 'app.js'), 'console.log("packed");');
  fs.writeFileSync(path.join(appRoot, 'src', 'assets', 'logo.svg'), '<svg></svg>');
  fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
  fs.symlinkSync(packageRoot, linkedRoot, 'dir');

  const summary = await createApplicationPayload(appRoot, output);
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(output)).toString('utf8'));
  const paths = new Set(archive.files.map((entry) => entry.path));

  assert.ok(paths.has('node_modules/@atom-js-org/runtime/package.json'));
  assert.ok(paths.has('node_modules/@atom-js-org/runtime/src/index.cjs'));
  assert.ok(paths.has('src/index.html'));
  assert.ok(paths.has('src/styles.css'));
  assert.ok(paths.has('src/app.js'));
  assert.ok(paths.has('src/assets/logo.svg'));
  assert.equal(summary.fileCount, archive.files.length);
  assert.ok(summary.sourceBytes > 0);
  assert.ok(summary.compressedBytes > 0);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});



test('macOS bundle keeps only the native window host visible in the Dock', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  assert.match(buildSource, /<key>LSUIElement<\/key><true\/>/);
  assert.match(buildSource, /<key>LSMultipleInstancesProhibited<\/key><true\/>/);
});

test('build command is local-first and does not require GitHub Actions', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  assert.match(buildSource, /Remote GitHub Actions builds are disabled/);
  assert.match(buildSource, /requestedTarget === 'current'/);
  assert.doesNotMatch(buildSource.slice(0, buildSource.indexOf('async function localBuild')), /return remoteBuild/);
});

test('Windows release packaging uses a GUI PE executable, branded metadata and customizable NSIS', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  const doctorSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'doctor.cjs'), 'utf8');

  assert.match(buildSource, /writeUInt16LE\(2, pe\.optionalHeaderOffset \+ 68\)/);
  assert.match(buildSource, /certificateDirectory = pe\.dataDirectoryOffset \+ \(8 \* 4\)/);
  assert.match(buildSource, /customizeWindowsExecutable/);
  assert.match(buildSource, /require\('rcedit'\)/);
  assert.match(buildSource, /requested-execution-level/);
  assert.match(buildSource, /const registryRoot = installMode === 'machine' \? 'HKLM' : 'HKCU'/);
  assert.match(buildSource, /MUI_HEADERIMAGE_BITMAP/);
  assert.match(buildSource, /MUI_WELCOMEFINISHPAGE_BITMAP/);
  assert.match(buildSource, /createDesktopShortcut/);
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


test('macOS packaging removes AppleDouble metadata before code signing', async () => {
  const { removeMacMetadataFiles } = require('../packages/cli/src/build.cjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-macos-metadata-'));
  const appBundle = path.join(tempRoot, 'Sample.app');
  const contents = path.join(appBundle, 'Contents');
  const resources = path.join(contents, 'Resources');

  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(contents, '._Info.plist'), 'apple-double');
  fs.writeFileSync(path.join(resources, '.DS_Store'), 'finder');
  fs.mkdirSync(path.join(resources, '__MACOSX'));
  fs.writeFileSync(path.join(resources, '__MACOSX', 'metadata'), 'x');

  const removed = await removeMacMetadataFiles(appBundle);

  assert.ok(removed.some((entry) => entry.endsWith('._Info.plist')));
  assert.equal(fs.existsSync(path.join(contents, '._Info.plist')), false);
  assert.equal(fs.existsSync(path.join(resources, '.DS_Store')), false);
  assert.equal(fs.existsSync(path.join(resources, '__MACOSX')), false);
  assert.equal(fs.existsSync(path.join(contents, 'Info.plist')), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('macOS bundle is signed on local staging storage and archived without resource sidecars', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');

  assert.match(buildSource, /mkdtemp\(path\.join\(stageBase, 'macos-app-'\)\)/);
  assert.match(buildSource, /sanitizeMacBundle\(appBundle\)/);
  assert.match(buildSource, /COPYFILE_DISABLE: '1'/);
  assert.match(buildSource, /ditto', \['--norsrc', '-c', '-k', '--keepParent'/);
  assert.doesNotMatch(buildSource, /--sequesterRsrc/);
});

test('macOS DMG is customizable, staged locally and copied to the output', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');

  assert.match(buildSource, /const dmgRoot = path\.join\(bundleStageRoot, 'dmg-root'\)/);
  assert.match(buildSource, /symlink\('\/Applications'/);
  assert.match(buildSource, /config\.dmg\.background/);
  assert.match(buildSource, /'-srcfolder', dmgRoot/);
  assert.match(buildSource, /fs\.promises\.copyFile\(temporaryDmgPath, dmgPath\)/);
  assert.match(buildSource, /ATOM_REQUIRE_DMG === '1'/);
  assert.doesNotMatch(buildSource, /'-srcfolder', finalAppBundle/);
});

test('loadProject preserves cross-platform packaging customization', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-config-'));
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({
    name: 'custom-app',
    version: '2.3.4-beta.1',
    description: 'Custom desktop app',
    author: 'Example Company'
  }));
  fs.writeFileSync(path.join(tempRoot, 'atom.config.json'), JSON.stringify({
    productName: 'Custom App',
    icon: 'assets/icon.png',
    build: {
      artifactName: '${productName}-${target}-${arch}',
      windows: {
        icon: 'assets/app.ico',
        installMode: 'machine',
        createDesktopShortcut: false,
        requestedExecutionLevel: 'requireAdministrator'
      },
      macos: {
        bundleName: 'Custom App Pro',
        signingIdentity: 'Developer ID Application: Example',
        hardenedRuntime: true,
        dmg: { volumeName: 'Custom Installer', background: 'assets/dmg.png' }
      },
      linux: {
        packageName: 'custom-app',
        binaryName: 'custom-app-bin',
        dependencies: ['libgtk-3-0'],
        rpmDependencies: ['gtk3'],
        deb: true,
        rpm: true
      }
    }
  }));

  const project = loadProject(tempRoot);
  assert.equal(project.config.build.windows.installMode, 'machine');
  assert.equal(project.config.build.windows.createDesktopShortcut, false);
  assert.equal(project.config.build.windows.requestedExecutionLevel, 'requireAdministrator');
  assert.equal(project.config.build.macos.bundleName, 'Custom App Pro');
  assert.equal(project.config.build.macos.hardenedRuntime, true);
  assert.equal(project.config.build.macos.dmg.volumeName, 'Custom Installer');
  assert.deepEqual(project.config.build.linux.dependencies, ['libgtk-3-0']);
  assert.deepEqual(project.config.build.linux.rpmDependencies, ['gtk3']);
  assert.equal(project.config.build.linux.rpm, true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('Linux packaging contains a standalone binary, Debian package, RPM path and AppImage path', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  assert.match(buildSource, /const portableBinary = path\.join\(buildRoot, binaryName\)/);
  assert.match(buildSource, /debian-binary/);
  assert.match(buildSource, /writeArArchive\(debPath/);
  assert.match(buildSource, /commandExists\('rpmbuild'/);
  assert.match(buildSource, /\.rpm`\)/);
  assert.match(buildSource, /\.AppImage`\)/);
  assert.equal(normalizeDebVersion('1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(normalizeRpmVersion('1.2.3-beta.1'), '1.2.3.beta.1');
});

test('Debian ar writer produces a valid archive header and member names', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomjs-deb-ar-'));
  const archivePath = path.join(tempRoot, 'sample.deb');
  await writeArArchive(archivePath, [
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: Buffer.from('control') },
    { name: 'data.tar.gz', data: Buffer.from('data') }
  ]);
  const archive = fs.readFileSync(archivePath);
  assert.equal(archive.subarray(0, 8).toString('ascii'), '!<arch>\n');
  assert.match(archive.toString('ascii'), /debian-binary\//);
  assert.match(archive.toString('ascii'), /control\.tar\.gz\//);
  assert.match(archive.toString('ascii'), /data\.tar\.gz\//);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('configuration schema exposes installer, app bundle and Linux package customization', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'atom.config.schema.json'), 'utf8'));
  const build = schema.properties.build.properties;
  assert.ok(build.windows.properties.installerIcon);
  assert.ok(build.windows.properties.headerImage);
  assert.ok(build.macos.properties.signingIdentity);
  assert.ok(build.macos.properties.dmg.properties.background);
  assert.ok(build.linux.properties.deb);
  assert.ok(build.linux.properties.rpm);
  assert.ok(build.linux.properties.rpmDependencies);
});


test('Windows builds use a prebuilt binding and dev mode does not spawn a second Node process', () => {
  const buildSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'build.cjs'), 'utf8');
  const runSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'run.cjs'), 'utf8');

  assert.match(buildSource, /target === 'windows'[\s\S]*@webviewjs\/webview/);
  assert.match(buildSource, /pkg\.dependencies\.koffi = '3\.1\.2'/);
  assert.match(buildSource, /prebuilt Win32 FFI package for native window movement/);
  assert.match(buildSource, /require\('koffi'\)/);
  assert.match(runSource, /await import\(pathToFileURL\(mainPath\)\.href\)/);
  assert.doesNotMatch(runSource, /spawn\(process\.execPath, \[mainPath\]/);
});
