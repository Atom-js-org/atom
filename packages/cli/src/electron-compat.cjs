'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fse = require('fs-extra');

async function ensureElectronCompatibility(projectRoot) {
  const target = path.join(projectRoot, 'node_modules', 'electron');
  const targetPackage = path.join(target, 'package.json');

  if (fs.existsSync(targetPackage)) {
    const existing = readJson(targetPackage);
    if (existing && existing.atomjsElectronCompatibility === true) return target;

    throw new Error(
      "A real or third-party 'electron' package already exists in node_modules. " +
      "AtomJS cannot safely replace it automatically. Remove that package and run AtomJS again; " +
      "AtomJS will install its lightweight Electron compatibility facade."
    );
  }

  const source = resolveElectronCompatibilityRoot(projectRoot);
  await fse.ensureDir(path.dirname(target));

  try {
    const resolvedSource = await fs.promises.realpath(source);

    await fs.promises.symlink(
      resolvedSource,
      target,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch {
    await fse.remove(target);
    await fse.copy(source, target);
  }

    return target;
  }

function resolveElectronCompatibilityRoot(projectRoot) {
  const sibling = path.resolve(__dirname, '..', '..', 'electron-compat');
  if (isAtomCompatPackage(sibling)) return sibling;

  for (const searchRoot of [projectRoot, process.cwd()]) {
    try {
      const packagePath = require.resolve('electron/package.json', { paths: [searchRoot] });
      const root = path.dirname(packagePath);
      if (isAtomCompatPackage(root)) return root;
    } catch {}
  }

  throw new Error(
    'AtomJS could not locate its Electron compatibility package. ' +
    'Reinstall the AtomJS distribution or add the compatibility package to the workspace.'
  );
}

function isAtomCompatPackage(directory) {
  const pkg = readJson(path.join(directory, 'package.json'));
  return Boolean(
    pkg &&
    ['electron', '@atom-js-org/electron'].includes(pkg.name) &&
    pkg.atomjsElectronCompatibility === true
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  ensureElectronCompatibility,
  resolveElectronCompatibilityRoot
};
