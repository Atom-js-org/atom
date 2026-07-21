'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { loadProject, hostTarget } = require('./utils.cjs');
const { ensureElectronCompatibility } = require('./electron-compat.cjs');

async function runCommand(mode, options = {}) {
  const normalized = String(mode).toLowerCase();
  if (normalized === 'dev') return runDev(options);
  if (normalized === 'build') return runBuild(options);
  throw new Error(`Unknown run mode '${mode}'. Use dev or build.`);
}

async function runDev(options) {
  const project = loadProject(options.project);
  const mainPath = path.resolve(project.root, project.config.main);
  if (!fs.existsSync(mainPath)) throw new Error(`Main file not found: ${mainPath}`);

  console.log(`AtomJS dev: ${project.config.productName}`);
  console.log(`Main: ${path.relative(project.root, mainPath)}`);

  await ensureElectronCompatibility(project.root);

  const iconPath = project.config.icon
    ? path.resolve(project.root, project.config.icon)
    : null;
  Object.assign(process.env, {
    ATOM_PROJECT_ROOT: project.root,
    ATOM_APP_NAME: project.config.productName,
    ATOM_APP_ID: project.config.appId,
    ...(iconPath && fs.existsSync(iconPath) ? { ATOM_APP_ICON: iconPath } : {}),
    ATOM_DEV: '1'
  });
  process.title = project.config.productName;
  process.chdir(project.root);
  await import(pathToFileURL(mainPath).href);
}

async function runBuild(options) {
  const project = loadProject(options.project);
  const target = hostTarget();
  const manifestPath = path.join(project.root, 'build', target, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No ${target} build found. Run 'atom build ${target}' first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const executable = path.resolve(project.root, 'build', target, manifest.run);
  if (!fs.existsSync(executable)) throw new Error(`Built executable not found: ${executable}`);

  console.log(`Running ${path.basename(executable)}`);
  const command = target === 'macos' && executable.endsWith('.app') ? 'open' : executable;
  const args = command === 'open' ? ['-W', executable] : [];
  const child = spawn(command, args, {
    cwd: path.dirname(executable),
    stdio: 'inherit'
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build exited with code ${code}`)));
  });
}

module.exports = { runCommand };
