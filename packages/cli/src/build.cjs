'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fse = require('fs-extra');
const archiver = require('archiver');
const { inject } = require('postject');
const {
  loadProject,
  hostTarget,
  run,
  capture,
  commandExists,
  validateTarget,
  sanitizeFilename
} = require('./utils.cjs');
const { resolveElectronCompatibilityRoot } = require('./electron-compat.cjs');

async function buildCommand(targetInput, options = {}) {
  const target = validateTarget(targetInput);
  const project = loadProject(options.project);
  const host = hostTarget();

  if (options.local && (target === 'all' || target !== host)) {
    throw new Error(`A local ${host} machine cannot produce a complete '${target}' release. Remove --local to use GitHub Actions.`);
  }

  const needsRemote = options.remote || target === 'all' || target !== host;
  if (needsRemote) return remoteBuild(project, target);
  return localBuild(project, host, options);
}

async function localBuild(project, target, options = {}) {
  if (target !== hostTarget()) {
    throw new Error(`Local target mismatch: host is ${hostTarget()}, requested ${target}`);
  }

  const buildRoot = path.join(project.root, 'build', target);
  const unpacked = path.join(buildRoot, 'portable');
  const appDir = null;
  const productName = sanitizeFilename(project.config.productName);

  console.log(`\nAtomJS build (${target})`);
  console.log(`Project: ${project.root}`);
  console.log(`Output:  ${buildRoot}`);

  await fse.remove(buildRoot);
  await fse.ensureDir(unpacked);

  const stageBase = await resolveShortStageBase();
  const stageRoot = await fs.promises.mkdtemp(path.join(stageBase, 's-'));
  const stagedApp = path.join(stageRoot, 'app');
  const payloadPath = path.join(stageRoot, 'atom-app.payload.gz');

  try {
    await copyApplication(project.root, stagedApp);
    await vendorFramework(stagedApp, project, target);
    await installProductionDependencies(stagedApp, options.skipInstall, target);

    console.log('Embedding application code and production dependencies into the executable...');
    await createApplicationPayload(stagedApp, payloadPath);

    const executableName = target === 'windows' ? `${productName}.exe` : productName;
    const executablePath = path.join(unpacked, executableName);
    await createSeaLauncher({
      executablePath,
      appDir,
      target,
      productName,
      appId: project.config.appId,
      payloadPath
    });

    const creditPath = path.join(unpacked, 'ATOMJS-CREDIT.txt');
    await fs.promises.writeFile(
      creditPath,
      'Built with AtomJS\nhttps://github.com/Atom-js-org/atom\nCredit is optional inside applications.\n',
      'utf8'
    );

    let outputs = [];
    let runPath = executablePath;
    let unpackedPath = unpacked;

    if (target === 'windows') {
      outputs = await packageWindows({ project, buildRoot, unpacked, executableName, productName });
    }
    if (target === 'macos') {
      const packaged = await packageMacOS({
        project,
        buildRoot,
        unpacked,
        executableName,
        productName,
        hostSource: path.join(resolveFrameworkRoot(project.root), 'src', 'runtime', 'macos-native-host.m')
      });
      outputs = packaged.outputs;
      runPath = packaged.appBundle;
      unpackedPath = packaged.appBundle;
      await fse.remove(unpacked);
    }
    if (target === 'linux') {
      outputs = await packageLinux({ project, buildRoot, unpacked, executableName, productName });
    }

    const manifest = {
      atomjsVersion: '0.4.5-alpha.0',
      target,
      productName,
      appId: project.config.appId,
      createdAt: new Date().toISOString(),
      run: path.relative(buildRoot, runPath),
      unpacked: path.relative(buildRoot, unpackedPath),
      outputs: outputs.map((file) => path.relative(buildRoot, file))
    };
    await fs.promises.writeFile(path.join(buildRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log('\nBuild complete:');
    console.log(`  ${path.relative(project.root, unpackedPath)}`);
    for (const output of outputs) console.log(`  ${path.relative(project.root, output)}`);
    return manifest;
  } finally {
    await fse.remove(stageRoot);
  }
}


async function resolveShortStageBase() {
  const configured = process.env.ATOMJS_TEMP_DIR || process.env.ATOM_TEMP_DIR;
  const candidates = configured
    ? [path.resolve(configured)]
    : process.platform === 'win32'
      ? [path.join(path.parse(process.cwd()).root, '.atomjs-tmp'), path.join(os.tmpdir(), 'atomjs')]
      : [path.join(os.tmpdir(), 'atomjs')];

  let lastError;
  for (const candidate of candidates) {
    try {
      await fse.ensureDir(candidate);
      await fs.promises.access(candidate, fs.constants.W_OK);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`AtomJS could not create a writable short staging directory: ${lastError ? lastError.message : 'unknown error'}`);
}

async function copyApplication(projectRoot, appDir) {
  await fse.copy(projectRoot, appDir, {
    dereference: false,
    filter(source) {
      const relative = path.relative(projectRoot, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return !['node_modules', 'build', '.git', '.atom'].includes(first);
    }
  });
}

async function vendorFramework(appDir, project, target) {
  const frameworkRoot = resolveFrameworkRoot(project.root);
  const electronCompatRoot = resolveElectronCompatibilityRoot(project.root);
  const vendorRoot = path.join(appDir, 'vendor', 'atomjs');
  const electronVendorRoot = path.join(appDir, 'vendor', 'electron-compat');
  await fse.ensureDir(path.dirname(vendorRoot));
  await fse.copy(frameworkRoot, vendorRoot, {
    filter(source) {
      const relative = path.relative(frameworkRoot, source);
      return !relative.startsWith('node_modules') && !relative.startsWith('.git');
    }
  });
  await fse.copy(electronCompatRoot, electronVendorRoot, {
    filter(source) {
      const relative = path.relative(electronCompatRoot, source);
      return !relative.startsWith('node_modules') && !relative.startsWith('.git');
    }
  });

  const packagePath = path.join(appDir, 'package.json');
  const pkg = JSON.parse(await fs.promises.readFile(packagePath, 'utf8'));
  pkg.dependencies = {
    ...(pkg.dependencies || {}),
    '@atom-js-org/runtime': 'file:vendor/atomjs',
    electron: 'file:vendor/electron-compat'
  };
  if (target !== 'macos' && process.env.ATOM_SKIP_WEBVIEW_CHECK !== '1') {
    pkg.dependencies['webview-nodejs'] = '0.5.0';
    if (pkg.optionalDependencies) delete pkg.optionalDependencies['webview-nodejs'];
  } else if (pkg.optionalDependencies) {
    delete pkg.optionalDependencies['webview-nodejs'];
  }
  pkg.overrides = { ...(pkg.overrides || {}), tar: '7.5.20' };
  delete pkg.devDependencies;
  delete pkg.workspaces;
  delete pkg.scripts?.prepare;
  await fs.promises.writeFile(packagePath, JSON.stringify(pkg, null, 2));
  await fse.remove(path.join(appDir, 'package-lock.json'));
  await fse.remove(path.join(appDir, 'npm-shrinkwrap.json'));
}

function resolveFrameworkRoot(projectRoot) {
  try {
    return path.dirname(require.resolve('@atom-js-org/runtime/package.json', { paths: [projectRoot, process.cwd()] }));
  } catch {
    const sibling = path.resolve(__dirname, '..', '..', 'atomjs');
    if (fs.existsSync(path.join(sibling, 'package.json'))) return sibling;
    throw new Error('Could not locate @atom-js-org/runtime. Install the AtomJS runtime in the project first.');
  }
}

async function installProductionDependencies(appDir, skipInstall, target) {
  if (skipInstall && fs.existsSync(path.join(appDir, 'node_modules', '@atom-js-org', 'runtime'))) return;
  console.log('Installing production dependencies for the target OS...');
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund'
  ], { cwd: appDir });

  const electronPackagePath = path.join(appDir, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(electronPackagePath)) {
    throw new Error('The AtomJS Electron compatibility facade was not installed in the staged application.');
  }

  if (target !== 'macos') {
    const bindingPath = path.join(appDir, 'node_modules', 'webview-nodejs');
    if (!fs.existsSync(bindingPath) && process.env.ATOM_SKIP_WEBVIEW_CHECK !== '1') {
      throw new Error('webview-nodejs was not installed. Run `atom doctor`, install the platform prerequisites, and retry the build.');
    }
  }
}

async function createApplicationPayload(appDir, outputPath) {
  const files = [];

  async function addFile(source, relative, stat) {
    files.push({
      path: relative.split(path.sep).join('/'),
      mode: stat.mode & 0o777,
      data: (await fs.promises.readFile(source)).toString('base64')
    });
  }

  async function visit(directory, relativePrefix = '', ancestors = new Set()) {
    const realDirectory = await fs.promises.realpath(directory);
    if (ancestors.has(realDirectory)) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(realDirectory);

    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;

      if (entry.isDirectory()) {
        await visit(absolute, relative, nextAncestors);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const resolved = await fs.promises.realpath(absolute);
        const stat = await fs.promises.stat(resolved);
        if (stat.isDirectory()) {
          await visit(resolved, relative, nextAncestors);
        } else if (stat.isFile()) {
          await addFile(resolved, relative, stat);
        }
        continue;
      }

      if (entry.isFile()) {
        const stat = await fs.promises.stat(absolute);
        await addFile(absolute, relative, stat);
      }
    }
  }

  await visit(appDir);
  const payload = Buffer.from(JSON.stringify({ format: 1, files }));
  const compressed = require('node:zlib').gzipSync(payload, { level: 9 });
  await fs.promises.writeFile(outputPath, compressed);
}

async function createSeaLauncher({ executablePath, appDir, target, productName, appId, payloadPath = null }) {
  const work = path.join(path.dirname(executablePath), '.sea-' + crypto.randomBytes(5).toString('hex'));
  await fse.ensureDir(work);
  const launcherPath = path.join(work, 'launcher.cjs');
  const blobPath = path.join(work, target === 'windows' ? 'sea-prep.blob.exe' : 'sea-prep.blob');
  const configPath = path.join(work, 'sea-config.json');

  if (!payloadPath) throw new Error('AtomJS SEA payload is required.');
  const launcher = createEmbeddedLauncherSource(productName, appId);
  await fs.promises.writeFile(launcherPath, launcher, 'utf8');

  const seaConfig = {
    main: launcherPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { 'atom-app': payloadPath }
  };
  await fs.promises.writeFile(configPath, JSON.stringify(seaConfig, null, 2));

  await run(process.execPath, ['--experimental-sea-config', configPath], { cwd: work });
  await fs.promises.copyFile(process.execPath, executablePath);

  if (target === 'windows') {
    await prepareWindowsExecutableForInjection(executablePath);
  }
  if (target === 'macos' && hasMacCodeSigningTool()) {
    spawnSync('/usr/bin/codesign', ['--remove-signature', executablePath], { stdio: 'ignore' });
  }

  await inject(executablePath, 'NODE_SEA_BLOB', await fs.promises.readFile(blobPath), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA'
  });

  if (target === 'windows') {
    await setWindowsGuiSubsystem(executablePath);
  } else {
    await fs.promises.chmod(executablePath, 0o755);
  }
  if (target === 'macos' && hasMacCodeSigningTool()) {
    await run('/usr/bin/codesign', ['--force', '--sign', '-', executablePath]);
  }
  await fse.remove(work);
}


async function prepareWindowsExecutableForInjection(executablePath) {
  const image = await fs.promises.readFile(executablePath);
  const pe = readPortableExecutableLayout(image);
  const certificateDirectory = pe.dataDirectoryOffset + (8 * 4);
  const certificateOffset = image.readUInt32LE(certificateDirectory);
  const certificateSize = image.readUInt32LE(certificateDirectory + 4);

  image.writeUInt32LE(0, certificateDirectory);
  image.writeUInt32LE(0, certificateDirectory + 4);
  image.writeUInt32LE(0, pe.optionalHeaderOffset + 64);

  const certificateEnd = certificateOffset + certificateSize;
  const output = certificateOffset > 0 && certificateSize > 0 && certificateEnd === image.length
    ? image.subarray(0, certificateOffset)
    : image;
  await fs.promises.writeFile(executablePath, output);
}

async function setWindowsGuiSubsystem(executablePath) {
  const image = await fs.promises.readFile(executablePath);
  const pe = readPortableExecutableLayout(image);
  image.writeUInt16LE(2, pe.optionalHeaderOffset + 68);
  image.writeUInt32LE(0, pe.optionalHeaderOffset + 64);
  await fs.promises.writeFile(executablePath, image);
}

function readPortableExecutableLayout(image) {
  if (image.length < 0x100 || image.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('AtomJS expected a Windows PE executable but the DOS header is missing.');
  }

  const peOffset = image.readUInt32LE(0x3c);
  const coffHeaderSize = 24;
  if (peOffset < 0x40 || peOffset + coffHeaderSize > image.length || image.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('AtomJS expected a Windows PE executable but the PE header is invalid.');
  }

  const optionalHeaderSize = image.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + coffHeaderSize;
  const optionalHeaderEnd = optionalHeaderOffset + optionalHeaderSize;
  if (optionalHeaderSize < 2 || optionalHeaderEnd > image.length) {
    throw new Error('AtomJS expected a complete Windows PE optional header.');
  }

  const magic = image.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`AtomJS does not support Windows PE optional-header magic 0x${magic.toString(16)}.`);
  }

  const dataDirectoryOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96);
  const certificateDirectoryEnd = dataDirectoryOffset + (8 * 5);
  if (certificateDirectoryEnd > optionalHeaderEnd) {
    throw new Error('AtomJS expected the Windows PE certificate data directory.');
  }

  return {
    optionalHeaderOffset,
    dataDirectoryOffset
  };
}

function createEmbeddedLauncherSource(productName, appId) {
  return `
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { getAsset } = require('node:sea');

const productName = ${JSON.stringify(productName)};
const appId = ${JSON.stringify(appId || 'com.atomjs.app')};
const payload = Buffer.from(getAsset('atom-app'));
const payloadHash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
const dataRoot = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const appDir = path.join(dataRoot, productName, 'AtomJS Runtime', payloadHash);
const marker = path.join(appDir, '.atom-ready');

if (!fs.existsSync(marker)) {
  const temporary = appDir + '.tmp-' + process.pid;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  const archive = JSON.parse(zlib.gunzipSync(payload).toString('utf8'));
  if (!archive || archive.format !== 1 || !Array.isArray(archive.files)) {
    throw new Error('AtomJS embedded application payload is invalid.');
  }

  for (const entry of archive.files) {
    const destination = path.resolve(temporary, String(entry.path));
    const root = path.resolve(temporary) + path.sep;
    if (!destination.startsWith(root)) throw new Error('Unsafe path in AtomJS application payload.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(entry.data, 'base64'));
    if (process.platform !== 'win32' && Number.isInteger(entry.mode)) fs.chmodSync(destination, entry.mode);
  }
  fs.writeFileSync(path.join(temporary, '.atom-ready'), payloadHash);
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.renameSync(temporary, appDir);
}

const packagePath = path.join(appDir, 'package.json');
if (!fs.existsSync(packagePath)) throw new Error('AtomJS could not materialize the embedded application.');

const executableDir = path.dirname(process.execPath);
process.chdir(appDir);
process.env.ATOM_PROJECT_ROOT = appDir;
process.env.ATOM_APP_NAME = productName;
process.env.ATOM_APP_ID = appId;
process.env.ATOM_BUILD = '1';
process.env.ATOM_EMBEDDED_RUNTIME = '1';
process.env.ATOM_WINDOW_HOST_ENTRY = path.join(appDir, 'vendor', 'atomjs', 'src', 'runtime', 'window-host.mjs');
process.env.ATOM_MACOS_HOST_EXECUTABLE = path.join(executableDir, 'AtomJSWindowHost');
const bundledMacIcon = path.join(executableDir, '..', 'Resources', 'AppIcon.icns');
if (process.platform === 'darwin' && fs.existsSync(bundledMacIcon)) {
  process.env.ATOM_APP_ICON = bundledMacIcon;
}
const hostModeIndex = process.argv.indexOf('--atomjs-window-host');
if (hostModeIndex !== -1) {
  const hostEntry = process.env.ATOM_WINDOW_HOST_ENTRY;
  const configPath = process.argv[hostModeIndex + 1];
  process.argv = [process.argv[0], hostEntry, configPath];
  import(pathToFileURL(hostEntry).href).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
  return;
}
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const mainPath = path.resolve(appDir, pkg.main || 'main.js');
const load = createRequire(packagePath);
load(mainPath);
`;
}

async function packageWindows({ project, buildRoot, unpacked, executableName, productName }) {
  const outputs = [];
  const zipPath = path.join(buildRoot, `${productName}-windows.zip`);
  await archiveDirectory(unpacked, zipPath, 'zip');
  outputs.push(zipPath);

  const nsisPath = path.join(buildRoot, 'installer.nsi');
  const installerPath = path.join(buildRoot, `${productName} Installer.exe`);
  const escapedSource = unpacked.replace(/\\/g, '\\\\');
  const version = String(project.packageJson.version || '0.0.0');
  const author = project.packageJson.author;
  const publisher = typeof author === 'string'
    ? author
    : author && typeof author === 'object' && author.name
      ? author.name
      : 'AtomJS application';
  const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${escapeNsis(project.config.appId)}`;
  const credit = project.config.installerCredit
    ? `!define MUI_WELCOMEPAGE_TEXT "This installer will install ${escapeNsis(productName)}.$\\r$\\n$\\r$\\nPowered by AtomJS — https://github.com/Atom-js-org/atom"`
    : '';
  const script = `
Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"
Name "${escapeNsis(productName)}"
OutFile "${installerPath.replace(/\\/g, '\\\\')}"
InstallDir "$LOCALAPPDATA\\Programs\\${escapeNsis(productName)}"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
${credit}
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\\${escapeNsis(executableName)}"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${escapedSource}\\*"
  CreateDirectory "$SMPROGRAMS\\${escapeNsis(productName)}"
  CreateShortcut "$SMPROGRAMS\\${escapeNsis(productName)}\\${escapeNsis(productName)}.lnk" "$INSTDIR\\${escapeNsis(executableName)}"
  CreateShortcut "$DESKTOP\\${escapeNsis(productName)}.lnk" "$INSTDIR\\${escapeNsis(executableName)}"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "${uninstallKey}" "DisplayName" "${escapeNsis(productName)}"
  WriteRegStr HKCU "${uninstallKey}" "DisplayVersion" "${escapeNsis(version)}"
  WriteRegStr HKCU "${uninstallKey}" "Publisher" "${escapeNsis(publisher)}"
  WriteRegStr HKCU "${uninstallKey}" "DisplayIcon" "$INSTDIR\\${escapeNsis(executableName)}"
  WriteRegStr HKCU "${uninstallKey}" "UninstallString" "$\\\"$INSTDIR\\Uninstall.exe$\\\""
  WriteRegDWORD HKCU "${uninstallKey}" "NoModify" 1
  WriteRegDWORD HKCU "${uninstallKey}" "NoRepair" 1
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\\${escapeNsis(productName)}.lnk"
  RMDir /r "$SMPROGRAMS\\${escapeNsis(productName)}"
  DeleteRegKey HKCU "${uninstallKey}"
  RMDir /r "$INSTDIR"
SectionEnd
`;
  await fs.promises.writeFile(nsisPath, script.trimStart(), 'utf8');

  const makensis = resolveNsisExecutable();
  if (makensis) {
    await run(makensis, [nsisPath]);
    if (fs.existsSync(installerPath)) outputs.push(installerPath);
  } else {
    console.warn('NSIS was not found; installer.nsi was generated but the .exe installer was skipped.');
  }
  return outputs;
}

function resolveNsisExecutable() {
  const candidates = [
    process.env.MAKENSIS_PATH,
    process.env.NSIS_HOME && path.join(process.env.NSIS_HOME, 'makensis.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'NSIS', 'makensis.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'NSIS', 'makensis.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'NSIS', 'makensis.exe')
  ].filter(Boolean);

  if (commandExists('makensis', ['/VERSION'])) return 'makensis';
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function hasMacCodeSigningTool() {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/codesign');
}

async function removeMacMetadataFiles(root) {
  const removed = [];
  if (!root || !fs.existsSync(root)) return removed;

  async function visit(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const isMetadata = entry.name === '.DS_Store'
        || entry.name === '__MACOSX'
        || entry.name.startsWith('._');

      if (isMetadata) {
        await fs.promises.rm(absolute, { recursive: true, force: true });
        removed.push(absolute);
        continue;
      }

      if (entry.isDirectory()) await visit(absolute);
    }
  }

  await visit(root);
  return removed;
}

async function sanitizeMacBundle(appBundle) {
  await removeMacMetadataFiles(appBundle);

  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/xattr')) {
    const result = spawnSync('/usr/bin/xattr', ['-cr', appBundle], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error) {
      console.warn(`AtomJS could not clear macOS extended attributes: ${result.error.message}`);
    } else if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      if (detail) console.warn(`AtomJS could not clear every macOS extended attribute: ${detail}`);
    }
  }

  // Filesystems such as exFAT can materialize extended attributes as AppleDouble
  // sidecars while xattr is running, so remove metadata once more afterwards.
  await removeMacMetadataFiles(appBundle);
}

async function packageMacOS({ project, buildRoot, unpacked, executableName, productName, hostSource }) {
  const outputs = [];
  const finalAppBundle = path.join(buildRoot, `${productName}.app`);
  const stageBase = await resolveShortStageBase();
  const bundleStageRoot = await fs.promises.mkdtemp(path.join(stageBase, 'macos-app-'));
  const appBundle = path.join(bundleStageRoot, `${productName}.app`);
  const contents = path.join(appBundle, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const mainExecutable = path.join(macosDir, productName);
  const nativeHost = path.join(macosDir, 'AtomJSWindowHost');

  try {
    await fse.ensureDir(macosDir);
    await fse.ensureDir(resources);
    await fse.copy(path.join(unpacked, executableName), mainExecutable);
    await fse.copy(path.join(unpacked, 'ATOMJS-CREDIT.txt'), path.join(resources, 'ATOMJS-CREDIT.txt'));
    await fs.promises.chmod(mainExecutable, 0o755);

    if (!fs.existsSync(hostSource)) {
      throw new Error(`AtomJS macOS native host source was not found: ${hostSource}`);
    }
    if (!commandExists('/usr/bin/xcrun', ['--version'])) {
      throw new Error('macOS builds require the Xcode Command Line Tools. Run `xcode-select --install`.');
    }

    await run('/usr/bin/xcrun', [
      'clang',
      '-fobjc-arc',
      '-fmodules',
      '-mmacosx-version-min=12.0',
      '-framework', 'Cocoa',
      '-framework', 'WebKit',
      hostSource,
      '-o', nativeHost
    ]);
    await fs.promises.chmod(nativeHost, 0o755);

    let iconEntry = '';
    const iconSource = project.config.icon ? path.resolve(project.root, project.config.icon) : null;
    if (iconSource && fs.existsSync(iconSource) && path.extname(iconSource).toLowerCase() === '.icns') {
      await fse.copy(iconSource, path.join(resources, 'AppIcon.icns'));
      iconEntry = '<key>CFBundleIconFile</key><string>AppIcon</string>';
    }

    const version = String(project.packageJson.version || '0.0.0');
    const bundleVersion = (version.match(/\d+/g) || ['1']).slice(0, 3).join('.');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${xml(productName)}</string>
<key>CFBundleIdentifier</key><string>${xml(project.config.appId)}</string>
<key>CFBundleName</key><string>${xml(productName)}</string>
<key>CFBundleDisplayName</key><string>${xml(productName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(version)}</string>
<key>CFBundleVersion</key><string>${xml(bundleVersion)}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
${iconEntry}
</dict></plist>`;
    const plistPath = path.join(contents, 'Info.plist');
    await fs.promises.writeFile(plistPath, plist, 'utf8');

    if (commandExists('/usr/bin/plutil', ['-help'])) {
      await run('/usr/bin/plutil', ['-lint', plistPath]);
    }

    await sanitizeMacBundle(appBundle);

    if (hasMacCodeSigningTool()) {
      const signingEnvironment = { ...process.env, COPYFILE_DISABLE: '1' };
      await run('/usr/bin/codesign', ['--force', '--sign', '-', nativeHost], { env: signingEnvironment });
      await run('/usr/bin/codesign', ['--force', '--sign', '-', mainExecutable], { env: signingEnvironment });

      // Signing nested Mach-O files on non-APFS volumes can create fresh `._*`
      // sidecars. They must not be present when the outer bundle is sealed.
      await sanitizeMacBundle(appBundle);
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], { env: signingEnvironment });
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], { env: signingEnvironment });
    }

    // Assemble and sign on the local temporary filesystem, then copy the sealed
    // bundle to the project output. This avoids AppleDouble metadata generated by
    // external/exFAT project drives such as /Volumes/... during codesign.
    await fse.remove(finalAppBundle);
    await fse.copy(appBundle, finalAppBundle);
    await fs.promises.chmod(path.join(finalAppBundle, 'Contents', 'MacOS', productName), 0o755);
    await fs.promises.chmod(path.join(finalAppBundle, 'Contents', 'MacOS', 'AtomJSWindowHost'), 0o755);
    await sanitizeMacBundle(finalAppBundle);

    if (hasMacCodeSigningTool()) {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', finalAppBundle], {
        env: { ...process.env, COPYFILE_DISABLE: '1' }
      });
    }

    const zipPath = path.join(buildRoot, `${productName}-macos.zip`);
    if (commandExists('ditto', ['-h'])) {
      await run('ditto', ['--norsrc', '-c', '-k', '--keepParent', finalAppBundle, zipPath], {
        env: { ...process.env, COPYFILE_DISABLE: '1' }
      });
    } else {
      await archiveDirectory(finalAppBundle, zipPath, 'zip', `${productName}.app`);
    }
    outputs.push(zipPath);

    if (commandExists('/usr/bin/hdiutil', ['help'])) {
      const dmgPath = path.join(buildRoot, `${productName}.dmg`);
      const temporaryDmgPath = path.join(bundleStageRoot, `${productName}.dmg`);

      try {
        // hdiutil can reject both source and output paths located on external,
        // removable, network, or non-APFS volumes. Create the image entirely on
        // the local temporary filesystem, then copy the finished DMG to build/.
        await fse.remove(temporaryDmgPath);
        await run('/usr/bin/hdiutil', [
          'create',
          '-volname', productName,
          '-srcfolder', appBundle,
          '-ov',
          '-format', 'UDZO',
          temporaryDmgPath
        ], {
          env: { ...process.env, COPYFILE_DISABLE: '1' }
        });

        await fse.remove(dmgPath);
        await fs.promises.copyFile(temporaryDmgPath, dmgPath);
        outputs.push(dmgPath);
      } catch (error) {
        await fse.remove(temporaryDmgPath);
        await fse.remove(dmgPath);

        if (process.env.ATOM_REQUIRE_DMG === '1') throw error;
        console.warn(`AtomJS could not create the optional macOS DMG; the signed .app and ZIP are still valid. ${error.message}`);
      }
    }

    return { outputs, appBundle: finalAppBundle };
  } finally {
    await fse.remove(bundleStageRoot);
  }
}

async function packageLinux({ project, buildRoot, unpacked, executableName, productName }) {
  const outputs = [];
  const tarPath = path.join(buildRoot, `${productName}-linux.tar.gz`);
  await archiveDirectory(unpacked, tarPath, 'tar');
  outputs.push(tarPath);

  const appDir = path.join(buildRoot, `${productName}.AppDir`);
  const usrBin = path.join(appDir, 'usr', 'bin');
  const usrLibApp = path.join(appDir, 'usr', 'lib', sanitizeFilename(project.packageJson.name || productName));
  await fse.ensureDir(usrBin);
  await fse.ensureDir(usrLibApp);
  await fse.copy(path.join(unpacked, executableName), path.join(usrBin, productName));
  await fse.copy(path.join(unpacked, 'ATOMJS-CREDIT.txt'), path.join(usrLibApp, 'ATOMJS-CREDIT.txt'));

  const appRun = `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/${productName}" "$@"\n`;
  await fs.promises.writeFile(path.join(appDir, 'AppRun'), appRun, { mode: 0o755 });
  const desktopName = sanitizeFilename(project.packageJson.name || productName).toLowerCase().replace(/\s+/g, '-');
  const desktop = `[Desktop Entry]\nType=Application\nName=${productName}\nExec=${productName}\nIcon=${desktopName}\nCategories=Development;Utility;\nTerminal=false\n`;
  await fs.promises.writeFile(path.join(appDir, `${desktopName}.desktop`), desktop, 'utf8');

  const iconSource = project.config.icon ? path.resolve(project.root, project.config.icon) : null;
  if (iconSource && fs.existsSync(iconSource)) {
    await fse.copy(iconSource, path.join(appDir, `${desktopName}.png`));
  }

  const tool = findAppImageTool();
  if (tool) {
    const appImagePath = path.join(buildRoot, `${productName}.AppImage`);
    await run(tool, [appDir, appImagePath], { env: { ...process.env, ARCH: process.arch === 'arm64' ? 'aarch64' : 'x86_64' } });
    outputs.push(appImagePath);
  } else {
    console.warn('appimagetool was not found; AppDir was created but AppImage generation was skipped.');
  }
  return outputs;
}

function findAppImageTool() {
  for (const name of ['appimagetool', 'appimagetool.AppImage']) {
    if (commandExists(name, ['--version'])) return name;
  }
  return null;
}

async function archiveDirectory(source, output, format, rootName) {
  await fse.ensureDir(path.dirname(output));
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(output);
    const archive = format === 'zip'
      ? archiver('zip', { zlib: { level: 9 } })
      : archiver('tar', { gzip: true, gzipOptions: { level: 9 } });
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(stream);
    archive.directory(source, rootName || false);
    archive.finalize();
  });
}

async function remoteBuild(project, target) {
  if (!commandExists('gh', ['--version'])) {
    throw new Error(
      "Cross-platform builds require GitHub CLI. Install it, run 'gh auth login', and try again."
    );
  }

  const repositoryRoot = resolveGitRepository(project.root);
  const auth = spawnSync('gh', ['auth', 'status'], { cwd: repositoryRoot, stdio: 'ignore' });
  if (auth.status !== 0) {
    throw new Error("GitHub CLI is not authenticated. Run 'gh auth login' and try again.");
  }

  const workflow = project.config.github.workflow || 'atom-build.yml';
  const branch = capture('git', ['branch', '--show-current'], { cwd: repositoryRoot }).trim() || 'main';
  const relativeProject = path.relative(repositoryRoot, project.root).split(path.sep).join('/') || '.';
  const dispatchTime = Date.now();

  console.log(`Dispatching remote AtomJS build '${target}' through ${workflow}...`);
  console.log(`Repository: ${repositoryRoot}`);
  console.log(`Project:    ${relativeProject}`);

  await run('gh', [
    'workflow', 'run', workflow,
    '--ref', branch,
    '-f', `target=${target}`,
    '-f', `project=${relativeProject}`
  ], { cwd: repositoryRoot });

  const runId = await waitForWorkflowRun(repositoryRoot, workflow, dispatchTime);
  await run('gh', ['run', 'watch', String(runId), '--exit-status'], { cwd: repositoryRoot });

  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomjs-build-'));
  try {
    await run('gh', ['run', 'download', String(runId), '--dir', temp], { cwd: repositoryRoot });
    const buildRoot = path.join(project.root, 'build');
    await fse.ensureDir(buildRoot);
    for (const entry of await fs.promises.readdir(temp, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^atom-build-(windows|macos|linux)$/);
      if (!match) continue;
      const osTarget = match[1];
      await fse.remove(path.join(buildRoot, osTarget));
      await fse.copy(path.join(temp, entry.name), path.join(buildRoot, osTarget));
      console.log(`Downloaded build/${osTarget}`);
    }
  } finally {
    await fse.remove(temp);
  }
}

function resolveGitRepository(startDirectory) {
  const result = spawnSync('git', ['-C', startDirectory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    throw new Error([
      'Cross-platform builds require the project to be inside a GitHub repository.',
      `Not a Git repository: ${startDirectory}`,
      '',
      'Create one, commit the project and push it to GitHub before running atom build all.'
    ].join('\n'));
  }

  return result.stdout.trim();
}

async function waitForWorkflowRun(repositoryRoot, workflow, dispatchTime) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const output = capture('gh', [
      'run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch',
      '--limit', '10', '--json', 'databaseId,createdAt'
    ], { cwd: repositoryRoot });
    const runs = JSON.parse(output);
    const match = runs.find((run) => new Date(run.createdAt).getTime() >= dispatchTime - 5000);
    if (match?.databaseId) return match.databaseId;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('The workflow was dispatched, but AtomJS could not find the GitHub Actions run.');
}

function escapeNsis(value) {
  return String(value).replace(/\$/g, '$$').replace(/"/g, '$\\"');
}

function xml(value) {
  return String(value).replace(/[<>&'\"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
}

module.exports = { buildCommand, localBuild, createApplicationPayload, readPortableExecutableLayout, removeMacMetadataFiles };
