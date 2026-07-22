#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const pkg = require('../package.json');
const { runCommand } = require('../src/run.cjs');
const { buildCommand } = require('../src/build.cjs');
const { doctorCommand } = require('../src/doctor.cjs');
const { initCommand } = require('../src/init.cjs');

const program = new Command();

program
  .name('atom')
  .description('Build fast, lightweight desktop apps with the system WebView')
  .version(pkg.version);

program
  .command('run')
  .description('Run an AtomJS project')
  .argument('<mode>', 'dev or build')
  .option('-p, --project <path>', 'project directory', process.cwd())
  .action(async (mode, options) => runCommand(mode, options));

program
  .command('build')
  .description('Build an AtomJS project')
  .argument('<target>', 'current, windows, macos, linux, or all')
  .option('-p, --project <path>', 'project directory', process.cwd())
  .option('--local', 'build on this machine (default; kept for compatibility)')
  .option('--remote', 'deprecated: remote GitHub Actions builds are disabled')
  .option('--skip-install', 'reuse staged node_modules when possible')
  .action(async (target, options) => buildCommand(target, options));

program
  .command('doctor')
  .description('Check Node.js and native WebView prerequisites')
  .option('-p, --project <path>', 'project directory', process.cwd())
  .action(async (options) => doctorCommand(options));

program
  .command('init')
  .description('Create a new AtomJS project')
  .argument('[directory]', 'new project directory', '.')
  .option('--name <name>', 'package name')
  .action(async (directory, options) => initCommand(directory, options));

program.parseAsync(process.argv).catch((error) => {
  console.error(`\nAtomJS error: ${error.message}`);
  if (process.env.ATOM_DEBUG === '1' && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
