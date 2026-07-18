import fs from 'node:fs';

const configPath = process.argv[2];
if (!configPath) {
  console.error('AtomJS window host expected a configuration file');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error('Unable to read AtomJS window configuration:', error);
  process.exit(1);
} finally {
  fs.rmSync(configPath, { force: true });
}

if (process.platform === 'darwin') {
  console.error('AtomJS macOS windows must use the shared native Cocoa host, not the legacy Node window host.');
  process.exit(1);
}

let Webview;
let SizeHint;
try {
  ({ Webview, SizeHint } = await import('webview-nodejs'));
} catch (error) {
  console.error('\nAtomJS could not load the system WebView binding.');
  console.error('Windows and Linux currently require the webview-nodejs package.');
  console.error('Run `atom doctor`, install the platform prerequisites, then install dependencies again.');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}

try {
  const view = new Webview(Boolean(config.debug));
  view.title(String(config.title || 'AtomJS App'));
  view.size(
    Number(config.width || 800),
    Number(config.height || 600),
    config.resizable === false ? SizeHint.Fixed : SizeHint.None
  );
  view.init(String(config.bridgeScript || ''));
  view.navigate(String(config.url));
  view.show();
} catch (error) {
  console.error('AtomJS native window failed:', error && error.stack ? error.stack : error);
  process.exit(1);
}
