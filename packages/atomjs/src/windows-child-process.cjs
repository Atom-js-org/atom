'use strict';

const PATCHED = Symbol.for('atomjs.windowsHiddenChildProcesses');

function installWindowsChildProcessDefaults(
  childProcess = require('node:child_process'),
  enabled = process.platform === 'win32' && process.env.ATOM_SHOW_CHILD_CONSOLES !== '1'
) {
  if (!enabled || !childProcess || childProcess[PATCHED]) return false;

  const spawn = childProcess.spawn;
  const spawnSync = childProcess.spawnSync;
  const exec = childProcess.exec;
  const execSync = childProcess.execSync;
  const execFile = childProcess.execFile;
  const execFileSync = childProcess.execFileSync;
  const fork = childProcess.fork;

  childProcess.spawn = copyFunctionProperties(function atomSpawn(command, args, options) {
    if (Array.isArray(args)) return spawn.call(this, command, args, hiddenByDefault(options));
    return spawn.call(this, command, hiddenByDefault(args));
  }, spawn);

  childProcess.spawnSync = copyFunctionProperties(function atomSpawnSync(command, args, options) {
    if (Array.isArray(args)) return spawnSync.call(this, command, args, hiddenByDefault(options));
    return spawnSync.call(this, command, hiddenByDefault(args));
  }, spawnSync);

  childProcess.exec = copyFunctionProperties(function atomExec(command, options, callback) {
    if (typeof options === 'function') return exec.call(this, command, hiddenByDefault(), options);
    return exec.call(this, command, hiddenByDefault(options), callback);
  }, exec);

  childProcess.execSync = copyFunctionProperties(function atomExecSync(command, options) {
    return execSync.call(this, command, hiddenByDefault(options));
  }, execSync);

  childProcess.execFile = copyFunctionProperties(function atomExecFile(file, args, options, callback) {
    if (Array.isArray(args)) {
      if (typeof options === 'function') {
        return execFile.call(this, file, args, hiddenByDefault(), options);
      }
      return execFile.call(this, file, args, hiddenByDefault(options), callback);
    }
    if (typeof args === 'function') return execFile.call(this, file, hiddenByDefault(), args);
    return execFile.call(this, file, hiddenByDefault(args), options);
  }, execFile);

  childProcess.execFileSync = copyFunctionProperties(function atomExecFileSync(file, args, options) {
    if (Array.isArray(args)) return execFileSync.call(this, file, args, hiddenByDefault(options));
    return execFileSync.call(this, file, hiddenByDefault(args));
  }, execFileSync);

  childProcess.fork = copyFunctionProperties(function atomFork(modulePath, args, options) {
    if (Array.isArray(args)) return fork.call(this, modulePath, args, hiddenByDefault(options));
    return fork.call(this, modulePath, hiddenByDefault(args));
  }, fork);

  Object.defineProperty(childProcess, PATCHED, {
    configurable: false,
    enumerable: false,
    value: true
  });
  return true;
}

function copyFunctionProperties(wrapper, original) {
  if (typeof original !== 'function') return wrapper;
  for (const key of Reflect.ownKeys(original)) {
    if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) continue;
    try {
      Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key));
    } catch {}
  }
  return wrapper;
}

function hiddenByDefault(options) {
  const normalized = options && typeof options === 'object' ? { ...options } : {};
  if (normalized.windowsHide == null) normalized.windowsHide = true;
  return normalized;
}

module.exports = {
  installWindowsChildProcessDefaults,
  hiddenByDefault
};
