'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function resolveAppIdentity(options = {}) {
  const projectRoot = path.resolve(
    options.projectRoot || process.env.ATOM_PROJECT_ROOT || process.cwd()
  );
  const packageJson = readJsonIfExists(path.join(projectRoot, 'package.json')) || {};
  const atomConfig = readJsonIfExists(path.join(projectRoot, 'atom.config.json')) || {};
  const appName = String(
    options.appName ||
    process.env.ATOM_APP_NAME ||
    atomConfig.productName ||
    packageJson.productName ||
    packageJson.name ||
    'AtomJS App'
  );
  const appId = sanitizeAppId(
    options.appId ||
    process.env.ATOM_APP_ID ||
    atomConfig.appId ||
    packageJson.appId ||
    `com.atomjs.${packageJson.name || appName}`
  );
  const embedded = options.embedded == null
    ? process.env.ATOM_EMBEDDED_RUNTIME === '1'
    : Boolean(options.embedded);

  // Development projects are separated by their project root. Packaged apps
  // use their stable app name so updates keep the same profile while two
  // products that accidentally reuse an appId do not share credentials.
  const profileScope = embedded ? appName : projectRoot;
  const profileHash = crypto
    .createHash('sha256')
    .update(appId)
    .update('\0')
    .update(profileScope)
    .digest('hex')
    .slice(0, 16);

  return {
    appId,
    appName,
    projectRoot,
    profileKey: `${sanitizePathSegment(appId)}-${profileHash}`
  };
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeAppId(value) {
  const normalized = String(value || 'com.atomjs.app')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized.includes('.') ? normalized : `com.atomjs.${normalized || 'app'}`;
}

function sanitizePathSegment(value) {
  return String(value || 'com.atomjs.app')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'com.atomjs.app';
}

module.exports = {
  resolveAppIdentity,
  sanitizeAppId,
  sanitizePathSegment
};
