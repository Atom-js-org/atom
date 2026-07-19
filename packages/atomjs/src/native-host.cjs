'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

let singleton = null;

class NativeHost {
  constructor(appName) {
    this.metadata = resolveMacHostMetadata(appName);
    this.appName = this.metadata.appName;
    this.child = null;
    this.startPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = new Map();
    this.windows = new Map();
    this.stdoutBuffer = '';
    this.nextRequestId = 1;
    this.stopping = false;
  }

  async createWindow(window, config) {
    const windowId = Number(window.id);
    await this.ensureStarted();
    this.windows.set(windowId, window);

    try {
      await this.request({
        command: 'create',
        windowId,
        config
      }, 15000);
    } catch (error) {
      this.windows.delete(windowId);
      throw error;
    }
  }

  async request(message, timeoutMs = 30000) {
    await this.ensureStarted();

    const requestId = `${process.pid}-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`AtomJS native host request timed out: ${message.command}`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });

      try {
        this.send({ ...message, requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  send(message) {
    if (!this.child || this.child.killed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('AtomJS native host is not running.');
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async ensureStarted() {
    if (process.platform !== 'darwin') {
      throw new Error('The shared native host is currently implemented for macOS only.');
    }

    if (this.child && !this.child.killed) return;
    if (!this.startPromise) {
      this.startPromise = this._start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }

    await this.startPromise;
  }

  async _start() {
    const executable = await resolveNativeHostExecutable(this.metadata);
    const args = [
      '--app-name', this.metadata.appName,
      '--app-id', this.metadata.appId
    ];
    if (this.metadata.iconPath) args.push('--app-icon', this.metadata.iconPath);

    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: process.env.ATOM_PROJECT_ROOT || process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit']
      });

      this.child = child;
      this.stopping = false;
      this.stdoutBuffer = '';
      this.readyResolve = resolve;
      this.readyReject = reject;

      const startupTimeout = setTimeout(() => {
        if (this.readyReject) {
          const rejectReady = this.readyReject;
          this._clearReadyHandlers();
          rejectReady(new Error('AtomJS native macOS host did not become ready within 20 seconds.'));
        }
        try { child.kill(); } catch {}
      }, 20000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._handleOutput(chunk));
      child.stdout.on('end', () => {
        if (this.stdoutBuffer) {
          this._handleLine(this.stdoutBuffer.replace(/\r$/, ''));
          this.stdoutBuffer = '';
        }
      });

      child.once('error', (error) => {
        clearTimeout(startupTimeout);
        if (this.readyReject) {
          const rejectReady = this.readyReject;
          this._clearReadyHandlers();
          rejectReady(error);
        }
      });

      child.once('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        const wasStopping = this.stopping;
        this.child = null;
        this.startPromise = null;

        if (this.readyReject) {
          const rejectReady = this.readyReject;
          this._clearReadyHandlers();
          rejectReady(new Error(`AtomJS native macOS host exited before startup (code ${code}, signal ${signal || 'none'}).`));
        }

        const error = new Error(`AtomJS native macOS host exited (code ${code}, signal ${signal || 'none'}).`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pending.clear();

        if (!wasStopping) {
          for (const window of this.windows.values()) {
            try {
              window._handleHostEvent({
                type: 'did-fail-load',
                error: error.message,
                url: window._currentUrl || ''
              });
            } catch {}
          }
        }
        this.windows.clear();
      });

      this._startupTimeout = startupTimeout;
    });
  }

  _handleOutput(chunk) {
    this.stdoutBuffer += chunk;

    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    if (!line) return;

    const prefix = '__ATOMJS_EVENT__';
    if (!line.startsWith(prefix)) {
      process.stdout.write(`${line}\n`);
      return;
    }

    let event;
    try {
      event = JSON.parse(line.slice(prefix.length));
    } catch (error) {
      console.warn('[AtomJS] Invalid native-host event:', error.message);
      return;
    }

    if (event.type === 'ready') {
      if (this._startupTimeout) clearTimeout(this._startupTimeout);
      if (this.readyResolve) {
        const resolveReady = this.readyResolve;
        this._clearReadyHandlers();
        resolveReady();
      }
      return;
    }

    if (event.type === 'host-error') {
      const error = new Error(event.error || 'AtomJS native macOS host reported an error.');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      console.error(`[AtomJS] ${error.message}`);
      return;
    }

    if (event.type === 'response' && event.requestId) {
      const pending = this.pending.get(String(event.requestId));
      if (!pending) return;

      this.pending.delete(String(event.requestId));
      clearTimeout(pending.timeout);

      if (event.ok === false) {
        pending.reject(new Error(event.error || 'AtomJS native host request failed.'));
      } else {
        pending.resolve(event.result);
      }
      return;
    }

    const windowId = Number(event.windowId);
    if (!Number.isFinite(windowId)) return;

    const window = this.windows.get(windowId);
    if (!window) return;

    if (event.type === 'closed') this.windows.delete(windowId);
    window._handleHostEvent(event);
  }

  _clearReadyHandlers() {
    this.readyResolve = null;
    this.readyReject = null;
    this._startupTimeout = null;
  }

  async stop() {
    if (!this.child) return;

    this.stopping = true;
    const child = this.child;

    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve());
    });

    try {
      this.send({ command: 'quit' });
    } catch {}

    const timeout = new Promise((resolve) => {
      setTimeout(() => {
        if (this.child === child && !child.killed) {
          try { child.kill('SIGTERM'); } catch {}
        }
        resolve();
      }, 1500).unref();
    });

    await Promise.race([exited, timeout]);
  }
}

function getNativeHost(appName) {
  if (!singleton) singleton = new NativeHost(appName);
  return singleton;
}

async function stopNativeHost() {
  if (!singleton) return;
  const host = singleton;
  singleton = null;
  await host.stop();
}

function resolveMacHostMetadata(appName) {
  const projectRoot = path.resolve(process.env.ATOM_PROJECT_ROOT || process.cwd());
  const packageJson = readJsonIfExists(path.join(projectRoot, 'package.json')) || {};
  const atomConfig = readJsonIfExists(path.join(projectRoot, 'atom.config.json')) || {};

  const resolvedName = String(
    process.env.ATOM_APP_NAME ||
    appName ||
    atomConfig.productName ||
    packageJson.productName ||
    packageJson.name ||
    'AtomJS App'
  );
  const appId = sanitizeBundleIdentifier(
    process.env.ATOM_APP_ID ||
    atomConfig.appId ||
    `com.atomjs.${packageJson.name || resolvedName}`
  );

  const configuredIcon = process.env.ATOM_APP_ICON || atomConfig.icon || null;
  const iconPath = configuredIcon
    ? path.resolve(projectRoot, configuredIcon)
    : null;

  return {
    appName: resolvedName,
    appId,
    iconPath: iconPath && fs.existsSync(iconPath) ? iconPath : null
  };
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeBundleIdentifier(value) {
  const normalized = String(value || 'com.atomjs.app')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return normalized.includes('.') ? normalized : `com.atomjs.${normalized || 'app'}`;
}

function sanitizeMacExecutableName(value) {
  return String(value || 'AtomJS App')
    .replace(/[/:\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'AtomJS App';
}

async function resolveNativeHostExecutable(metadata) {
  const bundled = process.env.ATOM_MACOS_HOST_EXECUTABLE;
  if (bundled) {
    const resolved = path.resolve(bundled);
    if (!fs.existsSync(resolved)) {
      throw new Error(`AtomJS native macOS host executable was not found: ${resolved}`);
    }
    return resolved;
  }

  const source = path.join(__dirname, 'runtime', 'macos-native-host.m');
  if (!fs.existsSync(source)) {
    throw new Error(`AtomJS native macOS host source was not found: ${source}`);
  }

  const sourceData = await fs.promises.readFile(source);
  const hashBuilder = crypto
    .createHash('sha256')
    .update(sourceData)
    .update(process.arch)
    .update(JSON.stringify({ appName: metadata.appName, appId: metadata.appId }));
  if (metadata.iconPath) hashBuilder.update(await fs.promises.readFile(metadata.iconPath));
  const hash = hashBuilder.digest('hex').slice(0, 20);

  const executableName = sanitizeMacExecutableName(metadata.appName);
  const outputDirectory = path.join(os.tmpdir(), 'atomjs-native-host', hash);
  const appBundle = path.join(outputDirectory, `${executableName}.app`);
  const executable = path.join(appBundle, 'Contents', 'MacOS', executableName);
  if (fs.existsSync(executable)) return executable;

  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const temporaryBundle = `${appBundle}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const contents = path.join(temporaryBundle, 'Contents');
  const macosDirectory = path.join(contents, 'MacOS');
  const resourcesDirectory = path.join(contents, 'Resources');
  const temporaryExecutable = path.join(macosDirectory, executableName);

  await fs.promises.mkdir(macosDirectory, { recursive: true });
  await fs.promises.mkdir(resourcesDirectory, { recursive: true });

  try {
    await runCompiler([
      'clang',
      '-fobjc-arc',
      '-fmodules',
      '-mmacosx-version-min=12.0',
      '-framework', 'Cocoa',
      '-framework', 'WebKit',
      source,
      '-o', temporaryExecutable
    ]);
    await fs.promises.chmod(temporaryExecutable, 0o755);

    let iconEntry = '';
    if (metadata.iconPath && path.extname(metadata.iconPath).toLowerCase() === '.icns') {
      await fs.promises.copyFile(metadata.iconPath, path.join(resourcesDirectory, 'AppIcon.icns'));
      iconEntry = '<key>CFBundleIconFile</key><string>AppIcon</string>';
    }

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${xmlEscape(executableName)}</string>
<key>CFBundleIdentifier</key><string>${xmlEscape(metadata.appId)}.dev-host</string>
<key>CFBundleName</key><string>${xmlEscape(metadata.appName)}</string>
<key>CFBundleDisplayName</key><string>${xmlEscape(metadata.appName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
${iconEntry}
</dict></plist>`;
    await fs.promises.writeFile(path.join(contents, 'Info.plist'), plist, 'utf8');

    try {
      await fs.promises.rename(temporaryBundle, appBundle);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    await fs.promises.rm(temporaryBundle, { recursive: true, force: true });
  }

  return executable;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function runCompiler(args) {
  const xcrun = '/usr/bin/xcrun';
  if (!fs.existsSync(xcrun)) {
    throw new Error('AtomJS requires the Xcode Command Line Tools. Run `xcode-select --install`.');
  }

  await new Promise((resolve, reject) => {
    const child = spawn(xcrun, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error([
        'AtomJS could not compile the native macOS WKWebView host.',
        stderr.trim() || stdout.trim() || `xcrun exited with code ${code}`
      ].join('\n')));
    });
  });
}

module.exports = {
  getNativeHost,
  stopNativeHost
};
