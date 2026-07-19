'use strict';

const windows = new Map();

module.exports = {
  windows,
  bridgeServer: null,
  nextWindowId: 1,
  focusedWindowId: null,
  projectRoot: process.env.ATOM_PROJECT_ROOT || process.cwd(),
  isQuitting: false
};
