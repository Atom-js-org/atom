'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadProject, commandExists } = require('./utils.cjs');

async function doctorCommand(options = {}) {
  const rows = [];
  rows.push(check('Node.js >= 20.12', isNodeSupported(), process.version));
  rows.push(check('npm', commandExists(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'])));

  if (process.platform === 'win32') {
    rows.push(check('PowerShell', commandExists('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])));
    rows.push(check('WebView2 Runtime', checkWindowsWebView2(), 'required by the native WebView'));
    rows.push(check('NSIS (optional installer)', commandExists('makensis', ['/VERSION'])));
  } else if (process.platform === 'darwin') {
    rows.push(check('osascript JavaScript host', fs.existsSync('/usr/bin/osascript')));
    rows.push(check('WebKit framework', fs.existsSync('/System/Library/Frameworks/WebKit.framework')));
    rows.push(check('codesign', commandExists('codesign', ['--version'])));
    rows.push(check('hdiutil', commandExists('hdiutil', ['help'])));
  } else {
    rows.push(check('pkg-config', commandExists('pkg-config', ['--version'])));
    rows.push(check('GTK 3', pkgConfigExists('gtk+-3.0'), 'install libgtk-3-dev'));
    rows.push(check('WebKitGTK 4.1', pkgConfigExists('webkit2gtk-4.1'), 'install libwebkit2gtk-4.1-dev'));
    rows.push(check('zenity (dialogs)', commandExists('zenity', ['--version'])));
    rows.push(check('appimagetool (optional)', commandExists('appimagetool', ['--version']) || commandExists('appimagetool.AppImage', ['--version'])));
  }

  if (process.platform === 'darwin') {
    rows.push(check('macOS WKWebView backend', true, 'built in through JavaScript for Automation'));
  } else {
    try {
      const project = loadProject(options.project);
      const binding = require.resolve('webview-nodejs/package.json', { paths: [project.root, process.cwd()] });
      rows.push(check('webview-nodejs package', true, path.dirname(binding)));
    } catch {
      rows.push(check('webview-nodejs package', false, 'install platform prerequisites, then run npm install webview-nodejs'));
    }
  }

  console.log('\nAtomJS doctor\n');
  let failed = false;
  for (const row of rows) {
    console.log(`${row.ok ? '✓' : '✗'} ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
    if (!row.ok && !row.name.includes('optional')) failed = true;
  }
  console.log('');
  if (failed) {
    process.exitCode = 1;
    console.log('One or more required checks failed.');
  } else {
    console.log('Required checks passed.');
  }
}

function isNodeSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 12);
}

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail };
}

function pkgConfigExists(name) {
  const result = spawnSync('pkg-config', ['--exists', name]);
  return !result.error && result.status === 0;
}

function checkWindowsWebView2() {
  const script = `
$paths = @(
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F1E7E4A4-BD05-43A5-BCC0-B7F5E0E9D7F5}',
  'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F1E7E4A4-BD05-43A5-BCC0-B7F5E0E9D7F5}',
  'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F1E7E4A4-BD05-43A5-BCC0-B7F5E0E9D7F5}'
)
foreach ($p in $paths) { if (Test-Path $p) { exit 0 } }
exit 1
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

module.exports = { doctorCommand };
