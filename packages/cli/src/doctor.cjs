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
    const webView2Version = getWindowsWebView2Version();
    rows.push(check('WebView2 Runtime', Boolean(webView2Version), webView2Version || 'required by the native WebView'));
    rows.push(check('NSIS (optional installer)', Boolean(resolveNsisExecutable())));
  } else if (process.platform === 'darwin') {
    rows.push(check('Xcode Command Line Tools', commandExists('/usr/bin/xcrun', ['--version']), 'required to compile the native Cocoa host'));
    rows.push(check('Clang', commandExists('/usr/bin/xcrun', ['clang', '--version'])));
    rows.push(check('WebKit framework', fs.existsSync('/System/Library/Frameworks/WebKit.framework')));
    rows.push(check('codesign', fs.existsSync('/usr/bin/codesign'), '/usr/bin/codesign'));
    rows.push(check('hdiutil', commandExists('hdiutil', ['help'])));
  } else {
    rows.push(check('pkg-config', commandExists('pkg-config', ['--version'])));
    rows.push(check('GTK 3', pkgConfigExists('gtk+-3.0'), 'install libgtk-3-dev'));
    rows.push(check('WebKitGTK 4.1', pkgConfigExists('webkit2gtk-4.1'), 'install libwebkit2gtk-4.1-dev'));
    rows.push(check('zenity (dialogs)', commandExists('zenity', ['--version'])));
    rows.push(check('appimagetool (optional)', commandExists('appimagetool', ['--version']) || commandExists('appimagetool.AppImage', ['--version'])));
  }

  if (process.platform === 'darwin') {
    rows.push(check('macOS WKWebView backend', true, 'shared native Cocoa host; no osascript process'));
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

function getWindowsWebView2Version() {
  const script = `
$paths = @(
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
foreach ($p in $paths) {
  try {
    $version = Get-ItemPropertyValue -Path $p -Name 'pv' -ErrorAction Stop
    if ($version -and $version -ne '0.0.0.0') {
      Write-Output $version
      exit 0
    }
  } catch {}
}
exit 1
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
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

module.exports = { doctorCommand };
