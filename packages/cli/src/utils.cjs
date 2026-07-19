'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TARGETS = new Set(['windows', 'macos', 'linux', 'all']);

function hostTarget() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function resolveProject(input) {
  let current = path.resolve(input || process.cwd());
  if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);

  while (true) {
    if (fs.existsSync(path.join(current, 'atom.config.json')) || fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find an AtomJS project from ${input || process.cwd()}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadProject(projectInput) {
  const root = resolveProject(projectInput);
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`Missing package.json in ${root}`);
  const packageJson = readJson(packagePath);
  const configPath = path.join(root, 'atom.config.json');
  const config = fs.existsSync(configPath) ? readJson(configPath) : {};
  const build = objectOrEmpty(config.build);
  const windows = objectOrEmpty(build.windows);
  const macos = objectOrEmpty(build.macos);
  const linux = objectOrEmpty(build.linux);
  const dmg = objectOrEmpty(macos.dmg);
  const productName = config.productName || packageJson.productName || packageJson.name || 'AtomJS App';
  const icon = config.icon || null;

  return {
    root,
    packageJson,
    config: {
      appId: config.appId || `com.atomjs.${sanitizeId(packageJson.name || 'app')}`,
      productName,
      main: config.main || packageJson.main || 'main.js',
      icon,
      files: config.files || ['**/*'],
      installerCredit: config.installerCredit !== false,
      build: {
        artifactName: build.artifactName || '${productName}-${version}-${target}-${arch}',
        windows: {
          icon: windows.icon || icon,
          installerIcon: windows.installerIcon || windows.icon || icon,
          headerImage: windows.headerImage || null,
          sidebarImage: windows.sidebarImage || null,
          language: windows.language || 'English',
          installMode: windows.installMode === 'machine' ? 'machine' : 'user',
          installDirectory: windows.installDirectory || null,
          createDesktopShortcut: windows.createDesktopShortcut !== false,
          createStartMenuShortcut: windows.createStartMenuShortcut !== false,
          allowDirectorySelection: windows.allowDirectorySelection !== false,
          runAfterFinish: windows.runAfterFinish !== false,
          welcomeText: windows.welcomeText || null,
          finishText: windows.finishText || null,
          publisher: windows.publisher || null,
          requestedExecutionLevel: ['asInvoker', 'highestAvailable', 'requireAdministrator'].includes(windows.requestedExecutionLevel)
            ? windows.requestedExecutionLevel
            : 'asInvoker'
        },
        macos: {
          icon: macos.icon || icon,
          bundleName: macos.bundleName || productName,
          category: macos.category || 'public.app-category.utilities',
          minimumSystemVersion: macos.minimumSystemVersion || '12.0',
          copyright: macos.copyright || null,
          signingIdentity: macos.signingIdentity || '-',
          entitlements: macos.entitlements || null,
          hardenedRuntime: macos.hardenedRuntime === true,
          dmg: {
            enabled: dmg.enabled !== false,
            artifactName: dmg.artifactName || null,
            volumeName: dmg.volumeName || productName,
            background: dmg.background || null
          }
        },
        linux: {
          icon: linux.icon || icon,
          binaryName: linux.binaryName || sanitizeFilename(packageJson.name || productName).toLowerCase().replace(/\s+/g, '-'),
          packageName: linux.packageName || sanitizeId(packageJson.name || productName),
          category: linux.category || 'Utility',
          maintainer: linux.maintainer || null,
          description: linux.description || packageJson.description || productName,
          dependencies: Array.isArray(linux.dependencies)
            ? linux.dependencies.map(String)
            : ['libgtk-3-0', 'libwebkit2gtk-4.1-0'],
          rpmDependencies: Array.isArray(linux.rpmDependencies)
            ? linux.rpmDependencies.map(String)
            : ['gtk3', 'webkit2gtk4.1'],
          appImage: linux.appImage !== false,
          deb: linux.deb !== false,
          rpm: linux.rpm !== false
        }
      },
      github: config.github || {}
    }
  };
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeSpawn(command, args) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  return { command, args };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const normalized = normalizeSpawn(command, args);
    const child = spawn(normalized.command, normalized.args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
      shell: false
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`));
    });
  });
}

function capture(command, args, options = {}) {
  const normalized = normalizeSpawn(command, args);
  const result = spawnSync(normalized.command, normalized.args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(message || `${command} exited with code ${result.status}`);
  }
  return (result.stdout || '').trim();
}

function commandExists(command, args = ['--version']) {
  const normalized = normalizeSpawn(command, args);
  const result = spawnSync(normalized.command, normalized.args, { stdio: 'ignore', shell: false });
  return !result.error && result.status === 0;
}

function validateTarget(target) {
  const normalized = String(target).toLowerCase();
  if (!TARGETS.has(normalized)) {
    throw new Error(`Unknown build target '${target}'. Use windows, macos, linux, or all.`);
  }
  return normalized;
}

function sanitizeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

function sanitizeFilename(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim() || 'AtomJS App';
}

module.exports = {
  TARGETS,
  hostTarget,
  resolveProject,
  readJson,
  loadProject,
  run,
  capture,
  commandExists,
  validateTarget,
  sanitizeId,
  sanitizeFilename
};
