'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  const file = path.join(root, relativePath);
  return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const { value: rootPackage } = readJson('package.json');
const version = String(rootPackage.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid root package version: ${JSON.stringify(version)}`);
}

for (const relativePath of [
  'packages/atomjs/package.json',
  'packages/cli/package.json',
  'packages/electron-compat/package.json'
]) {
  const { file, value } = readJson(relativePath);
  value.version = version;
  if (relativePath === 'packages/electron-compat/package.json') {
    value.dependencies ||= {};
    value.dependencies['@atom-js-org/runtime'] = version;
  }
  writeJson(file, value);
}

const { file: lockFile, value: lock } = readJson('package-lock.json');
lock.version = version;
lock.packages ||= {};

for (const packagePath of [
  '',
  'packages/atomjs',
  'packages/cli',
  'packages/electron-compat'
]) {
  if (!lock.packages[packagePath]) {
    throw new Error(`Missing package-lock workspace entry: ${packagePath || '<root>'}`);
  }
  lock.packages[packagePath].version = version;
}

lock.packages['packages/electron-compat'].dependencies ||= {};
lock.packages['packages/electron-compat'].dependencies['@atom-js-org/runtime'] = version;
writeJson(lockFile, lock);

console.log(`Synchronized AtomJS workspace metadata to ${version}.`);

