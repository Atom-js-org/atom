import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configPath = process.argv[2];
if (!configPath) {
  console.error('AtomJS window host expected a configuration file');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error('Unable to read AtomJS window configuration:', error);
  process.exit(1);
}

if (process.platform === 'darwin') {
  await runMacOSHost(configPath);
} else {
  fs.rmSync(configPath, { force: true });
  await runNativeBindingHost(config);
}

async function runMacOSHost(configurationPath) {
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const helperPath = path.join(runtimeDirectory, 'macos-window-host.jxa.js');
  const osascript = '/usr/bin/osascript';

  if (!fs.existsSync(osascript)) {
    console.error('AtomJS could not find /usr/bin/osascript, required for the pure-JavaScript macOS WKWebView host.');
    fs.rmSync(configurationPath, { force: true });
    process.exit(1);
  }

  const child = spawn(osascript, ['-l', 'JavaScript', helperPath, configurationPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit']
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  process.once('SIGHUP', () => forwardSignal('SIGHUP'));

  await new Promise((resolve) => {
    child.once('error', (error) => {
      console.error('AtomJS macOS WKWebView host failed to start:', error && error.stack ? error.stack : error);
      process.exitCode = 1;
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (code !== 0 && signal == null) process.exitCode = code || 1;
      resolve();
    });
  });

  fs.rmSync(configurationPath, { force: true });
}

async function runNativeBindingHost(runtimeConfig) {
  let Webview;
  let SizeHint;
  try {
    ({ Webview, SizeHint } = await import('webview-nodejs'));
  } catch (error) {
    console.error('\nAtomJS could not load the system WebView binding.');
    console.error('Windows and Linux currently require the webview-nodejs package.');
    console.error('Run `atom doctor`, install the platform prerequisites, then install dependencies again.');
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }

  try {
    const view = new Webview(Boolean(runtimeConfig.debug));
    view.title(String(runtimeConfig.title || 'AtomJS App'));
    view.size(
      Number(runtimeConfig.width || 800),
      Number(runtimeConfig.height || 600),
      runtimeConfig.resizable === false ? SizeHint.Fixed : SizeHint.None
    );
    view.init(String(runtimeConfig.bridgeScript || ''));
    view.navigate(String(runtimeConfig.url));
    view.show();
  } catch (error) {
    console.error('AtomJS native window failed:', error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
