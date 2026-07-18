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
  const unpacked = path.join(buildRoot, 'unpacked');
  const appDir = path.join(unpacked, 'app');
  const productName = sanitizeFilename(project.config.productName);

  console.log(`\nAtomJS build (${target})`);
  console.log(`Project: ${project.root}`);
  console.log(`Output:  ${buildRoot}`);

  await fse.remove(buildRoot);
  await fse.ensureDir(unpacked);

  const stageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomjs-stage-'));
  const stagedApp = path.join(stageRoot, 'app');
  try {
    await copyApplication(project.root, stagedApp);
    await vendorFramework(stagedApp, project, target);
    await installProductionDependencies(stagedApp, options.skipInstall, target);
    await fse.move(stagedApp, appDir, { overwrite: true });
  } finally {
    await fse.remove(stageRoot);
  }

  const runtimeDir = path.join(unpacked, 'runtime');
  await fse.ensureDir(runtimeDir);
  const runtimeNodeName = target === 'windows' ? 'node.exe' : 'node';
  const runtimeNodePath = path.join(runtimeDir, runtimeNodeName);
  await fs.promises.copyFile(process.execPath, runtimeNodePath);
  if (target !== 'windows') await fs.promises.chmod(runtimeNodePath, 0o755);

  const executableName = target === 'windows' ? `${productName}.exe` : productName;
  const executablePath = path.join(unpacked, executableName);
  await createSeaLauncher({ executablePath, appDir, target });

  const creditPath = path.join(unpacked, 'ATOMJS-CREDIT.txt');
  await fs.promises.writeFile(
    creditPath,
    'Built with AtomJS\nhttps://github.com/Atom-js-org/atom\nCredit is optional inside applications.\n',
    'utf8'
  );

  const outputs = [];
  if (target === 'windows') outputs.push(...await packageWindows({ project, buildRoot, unpacked, executableName, productName }));
  if (target === 'macos') outputs.push(...await packageMacOS({ project, buildRoot, unpacked, executableName, productName }));
  if (target === 'linux') outputs.push(...await packageLinux({ project, buildRoot, unpacked, executableName, productName }));

  const manifest = {
    atomjsVersion: '0.2.0-alpha.0',
    target,
    productName,
    appId: project.config.appId,
    createdAt: new Date().toISOString(),
    run: path.relative(buildRoot, executablePath),
    unpacked: path.relative(buildRoot, unpacked),
    outputs: outputs.map((file) => path.relative(buildRoot, file))
  };
  await fs.promises.writeFile(path.join(buildRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\nBuild complete:');
  console.log(`  ${path.relative(project.root, unpacked)}`);
  for (const output of outputs) console.log(`  ${path.relative(project.root, output)}`);
  return manifest;
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

async function createSeaLauncher({ executablePath, appDir, target }) {
  const work = path.join(path.dirname(executablePath), '.sea-' + crypto.randomBytes(5).toString('hex'));
  await fse.ensureDir(work);
  const launcherPath = path.join(work, 'launcher.cjs');
  const blobPath = path.join(work, target === 'windows' ? 'sea-prep.blob.exe' : 'sea-prep.blob');
  const configPath = path.join(work, 'sea-config.json');

  const launcher = `
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const executableDir = path.dirname(process.execPath);
const appDir = process.platform === 'darwin' && executableDir.includes('.app' + path.sep + 'Contents' + path.sep + 'MacOS')
  ? path.resolve(executableDir, '..', 'Resources', 'app')
  : path.join(executableDir, 'app');

const packagePath = path.join(appDir, 'package.json');
if (!fs.existsSync(packagePath)) {
  console.error('AtomJS application files are missing:', appDir);
  process.exit(1);
}

const runtimeNode = process.platform === 'darwin' && executableDir.includes('.app' + path.sep + 'Contents' + path.sep + 'MacOS')
  ? path.resolve(executableDir, '..', 'Resources', 'runtime', 'node')
  : path.join(executableDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');

process.chdir(appDir);
process.env.ATOM_PROJECT_ROOT = appDir;
process.env.ATOM_BUILD = '1';
process.env.ATOM_NODE_EXECUTABLE = runtimeNode;
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const mainPath = path.resolve(appDir, pkg.main || 'main.js');
const load = createRequire(packagePath);
load(mainPath);
`;
  await fs.promises.writeFile(launcherPath, launcher, 'utf8');

  const seaConfig = {
    main: launcherPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  await fs.promises.writeFile(configPath, JSON.stringify(seaConfig, null, 2));

  await run(process.execPath, ['--experimental-sea-config', configPath], { cwd: work });
  await fs.promises.copyFile(process.execPath, executablePath);

  if (target === 'macos' && commandExists('codesign', ['--version'])) {
    spawnSync('codesign', ['--remove-signature', executablePath], { stdio: 'ignore' });
  }

  await inject(executablePath, 'NODE_SEA_BLOB', await fs.promises.readFile(blobPath), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA'
  });

  if (target !== 'windows') await fs.promises.chmod(executablePath, 0o755);
  if (target === 'macos' && commandExists('codesign', ['--version'])) {
    await run('codesign', ['--sign', '-', executablePath]);
  }
  await fse.remove(work);
}

async function packageWindows({ project, buildRoot, unpacked, executableName, productName }) {
  const outputs = [];
  const zipPath = path.join(buildRoot, `${productName}-windows.zip`);
  await archiveDirectory(unpacked, zipPath, 'zip');
  outputs.push(zipPath);

  const nsisPath = path.join(buildRoot, 'installer.nsi');
  const installerPath = path.join(buildRoot, `${productName} Installer.exe`);
  const escapedSource = unpacked.replace(/\\/g, '\\\\');
  const credit = project.config.installerCredit
    ? `!define MUI_WELCOMEPAGE_TEXT "This installer will install ${escapeNsis(productName)}.$\\r$\\n$\\r$\\nPowered by AtomJS — https://github.com/Atom-js-org/atom"`
    : '';
  const script = `
Unicode true
!include "MUI2.nsh"
Name "${escapeNsis(productName)}"
OutFile "${installerPath.replace(/\\/g, '\\\\')}"
InstallDir "$LOCALAPPDATA\\Programs\\${escapeNsis(productName)}"
RequestExecutionLevel user
${credit}
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${escapedSource}\\*"
  CreateDirectory "$SMPROGRAMS\\${escapeNsis(productName)}"
  CreateShortcut "$SMPROGRAMS\\${escapeNsis(productName)}\\${escapeNsis(productName)}.lnk" "$INSTDIR\\${escapeNsis(executableName)}"
  CreateShortcut "$DESKTOP\\${escapeNsis(productName)}.lnk" "$INSTDIR\\${escapeNsis(executableName)}"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$DESKTOP\\${escapeNsis(productName)}.lnk"
  RMDir /r "$SMPROGRAMS\\${escapeNsis(productName)}"
  RMDir /r "$INSTDIR"
SectionEnd
`;
  await fs.promises.writeFile(nsisPath, script.trimStart(), 'utf8');

  if (commandExists('makensis', ['/VERSION'])) {
    await run('makensis', [nsisPath]);
    if (fs.existsSync(installerPath)) outputs.push(installerPath);
  } else {
    console.warn('NSIS was not found; installer.nsi was generated but the .exe installer was skipped.');
  }
  return outputs;
}

async function packageMacOS({ project, buildRoot, unpacked, executableName, productName }) {
  const outputs = [];
  const appBundle = path.join(buildRoot, `${productName}.app`);
  const contents = path.join(appBundle, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  await fse.ensureDir(macosDir);
  await fse.ensureDir(resources);
  await fse.copy(path.join(unpacked, executableName), path.join(macosDir, productName));
  await fse.copy(path.join(unpacked, 'app'), path.join(resources, 'app'));
  await fse.copy(path.join(unpacked, 'runtime'), path.join(resources, 'runtime'));
  await fse.copy(path.join(unpacked, 'ATOMJS-CREDIT.txt'), path.join(resources, 'ATOMJS-CREDIT.txt'));

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${xml(productName)}</string>
<key>CFBundleIdentifier</key><string>${xml(project.config.appId)}</string>
<key>CFBundleName</key><string>${xml(productName)}</string>
<key>CFBundleDisplayName</key><string>${xml(productName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(project.packageJson.version || '0.0.0')}</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`;
  await fs.promises.writeFile(path.join(contents, 'Info.plist'), plist, 'utf8');
  await fs.promises.chmod(path.join(macosDir, productName), 0o755);

  if (commandExists('codesign', ['--version'])) await run('codesign', ['--force', '--deep', '--sign', '-', appBundle]);

  const zipPath = path.join(buildRoot, `${productName}-macos.zip`);
  if (commandExists('ditto', ['-h'])) {
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, zipPath]);
  } else {
    await archiveDirectory(appBundle, zipPath, 'zip', `${productName}.app`);
  }
  outputs.push(zipPath);

  if (commandExists('hdiutil', ['help'])) {
    const dmgPath = path.join(buildRoot, `${productName}.dmg`);
    await run('hdiutil', ['create', '-volname', productName, '-srcfolder', appBundle, '-ov', '-format', 'UDZO', dmgPath]);
    outputs.push(dmgPath);
  }
  return outputs;
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
  await fse.copy(path.join(unpacked, 'app'), path.join(usrBin, 'app'));
  await fse.copy(path.join(unpacked, 'runtime'), path.join(usrBin, 'runtime'));
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

module.exports = { buildCommand, localBuild };
