'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveAppIdentity } = require('../packages/atomjs/src/app-identity.cjs');

test('development applications never share a WebView profile by appId alone', () => {
  const first = resolveAppIdentity({
    appId: 'com.example.launcher',
    appName: 'Launcher',
    projectRoot: path.resolve('/projects/first-launcher'),
    embedded: false
  });
  const second = resolveAppIdentity({
    appId: 'com.example.launcher',
    appName: 'Launcher',
    projectRoot: path.resolve('/projects/second-launcher'),
    embedded: false
  });

  assert.equal(first.appId, second.appId);
  assert.notEqual(first.profileKey, second.profileKey);
});

test('packaged products with an accidentally reused appId still get separate profiles', () => {
  const first = resolveAppIdentity({
    appId: 'com.example.launcher',
    appName: 'First Launcher',
    projectRoot: '/ignored/first',
    embedded: true
  });
  const second = resolveAppIdentity({
    appId: 'com.example.launcher',
    appName: 'Second Launcher',
    projectRoot: '/ignored/second',
    embedded: true
  });
  const firstUpdate = resolveAppIdentity({
    appId: 'com.example.launcher',
    appName: 'First Launcher',
    projectRoot: '/a/new/version/path',
    embedded: true
  });

  assert.notEqual(first.profileKey, second.profileKey);
  assert.equal(first.profileKey, firstUpdate.profileKey);
});
