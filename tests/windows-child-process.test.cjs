'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installWindowsChildProcessDefaults,
  hiddenByDefault
} = require('../packages/atomjs/src/windows-child-process.cjs');

test('Windows GUI applications hide child consoles unless explicitly requested', () => {
  const calls = [];
  const childProcess = {
    spawn(...args) { calls.push(['spawn', ...args]); return {}; },
    spawnSync(...args) { calls.push(['spawnSync', ...args]); return {}; },
    exec(...args) { calls.push(['exec', ...args]); return {}; },
    execSync(...args) { calls.push(['execSync', ...args]); return {}; },
    execFile(...args) { calls.push(['execFile', ...args]); return {}; },
    execFileSync(...args) { calls.push(['execFileSync', ...args]); return {}; },
    fork(...args) { calls.push(['fork', ...args]); return {}; }
  };

  assert.equal(installWindowsChildProcessDefaults(childProcess, true), true);
  childProcess.spawn('java', ['-version'], { detached: true });
  childProcess.exec('"java" -version', () => {});

  assert.deepEqual(calls[0][3], { detached: true, windowsHide: true });
  assert.equal(calls[1][2].windowsHide, true);
  assert.equal(installWindowsChildProcessDefaults(childProcess, true), false);
});

test('an explicit windowsHide false keeps developer-controlled console windows visible', () => {
  assert.deepEqual(hiddenByDefault({ windowsHide: false, detached: true }), {
    windowsHide: false,
    detached: true
  });
});
