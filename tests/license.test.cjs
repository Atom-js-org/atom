'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('license distinguishes framework attribution from generated applications', () => {
  const license = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  assert.match(license, /https:\/\/github\.com\/Atom-js-org\/atom/);
  assert.match(license, /does not require applications/i);
  assert.match(license, /forks/i);
});
