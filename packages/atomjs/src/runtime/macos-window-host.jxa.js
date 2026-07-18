ObjC.import('Cocoa');
ObjC.import('WebKit');

let atomWindow = null;
let atomWebView = null;
let atomWindowDelegate = null;
let atomNavigationDelegate = null;


function emitHostEvent(payload) {
  try {
    const line = `__ATOMJS_EVENT__${JSON.stringify(payload)}\n`;
    const data = $(line).dataUsingEncoding($.NSUTF8StringEncoding);
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
  } catch (_) {}
}

function webViewUrl(webView) {
  try {
    if (!webView || !webView.URL) return '';
    return ObjC.unwrap(webView.URL.absoluteString) || '';
  } catch (_) {
    return '';
  }
}

function createNavigationDelegate() {
  if (!$.AtomJSNavigationDelegate) {
    ObjC.registerSubclass({
      name: 'AtomJSNavigationDelegate',
      protocols: ['WKNavigationDelegate'],
      methods: {
        'webView:didStartProvisionalNavigation:'(webView) {
          emitHostEvent({ type: 'did-start-loading', url: webViewUrl(webView) });
        },
        'webView:didFinishNavigation:'(webView) {
          emitHostEvent({ type: 'did-finish-load', url: webViewUrl(webView) });
        },
        'webView:didFailNavigation:withError:'(webView, _navigation, error) {
          emitHostEvent({
            type: 'did-fail-load',
            url: webViewUrl(webView),
            error: error ? ObjC.unwrap(error.localizedDescription) : 'Navigation failed'
          });
        },
        'webView:didFailProvisionalNavigation:withError:'(webView, _navigation, error) {
          emitHostEvent({
            type: 'did-fail-load',
            url: webViewUrl(webView),
            error: error ? ObjC.unwrap(error.localizedDescription) : 'Navigation failed'
          });
        }
      }
    });
  }
  return $.AtomJSNavigationDelegate.alloc.init;
}

function readUtf8(filePath) {
  const value = $.NSString.stringWithContentsOfFileEncodingError(
    $(String(filePath)),
    $.NSUTF8StringEncoding,
    null
  );
  if (!value) throw new Error(`Unable to read AtomJS window configuration: ${filePath}`);
  return ObjC.unwrap(value);
}

function createWindowDelegate() {
  if (!$.AtomJSWindowDelegate) {
    ObjC.registerSubclass({
      name: 'AtomJSWindowDelegate',
      protocols: ['NSWindowDelegate'],
      methods: {
        'windowWillClose:'() {
          $.NSApplication.sharedApplication.terminate(null);
        }
      }
    });
  }
  return $.AtomJSWindowDelegate.alloc.init;
}

function makeWindow(config) {
  const width = Math.max(320, Number(config.width) || 800);
  const height = Math.max(240, Number(config.height) || 600);
  const rect = $.NSMakeRect(0, 0, width, height);

  let styleMask = $.NSTitledWindowMask |
    $.NSClosableWindowMask |
    $.NSMiniaturizableWindowMask;
  if (config.resizable !== false) styleMask |= $.NSResizableWindowMask;

  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    rect,
    styleMask,
    $.NSBackingStoreBuffered,
    false
  );
  win.releasedWhenClosed = false;
  win.title = $(String(config.title || 'AtomJS App'));
  win.center;

  const contentController = $.WKUserContentController.alloc.init;
  const bridgeSource = String(config.bridgeScript || '');
  if (bridgeSource) {
    const userScript = $.WKUserScript.alloc.initWithSourceInjectionTimeForMainFrameOnly(
      $(bridgeSource),
      $.WKUserScriptInjectionTimeAtDocumentStart,
      true
    );
    contentController.addUserScript(userScript);
  }

  const webConfiguration = $.WKWebViewConfiguration.alloc.init;
  webConfiguration.userContentController = contentController;

  const webView = $.WKWebView.alloc.initWithFrameConfiguration(rect, webConfiguration);
  atomNavigationDelegate = createNavigationDelegate();
  webView.navigationDelegate = atomNavigationDelegate;
  webView.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;

  const url = $.NSURL.URLWithString($(String(config.url)));
  if (!url) throw new Error(`Invalid AtomJS URL: ${config.url}`);
  webView.loadRequest($.NSURLRequest.requestWithURL(url));

  atomWindowDelegate = createWindowDelegate();
  win.delegate = atomWindowDelegate;
  win.contentView.addSubview(webView);

  atomWindow = win;
  atomWebView = webView;
  return win;
}

function run(argv) {
  if (!argv || argv.length < 1) throw new Error('AtomJS macOS host expected a configuration path');
  const config = JSON.parse(readUtf8(argv[0]));
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);

  const win = makeWindow(config);
  win.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);
  app.run;
  return 0;
}
