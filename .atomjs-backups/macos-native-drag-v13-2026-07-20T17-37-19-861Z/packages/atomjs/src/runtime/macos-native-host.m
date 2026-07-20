#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static NSString *const AtomJSEventPrefix = @"__ATOMJS_EVENT__";

@class AtomJSWindowController;
static NSMutableDictionary<NSNumber *, AtomJSWindowController *> *atomWindows;
static NSString *atomAppName = @"AtomJS App";
static NSString *atomAppIdentifier = @"com.atomjs.app";
static NSString *atomAppIconPath = nil;

static void AtomJSEmit(NSDictionary *payload) {
  if (![NSJSONSerialization isValidJSONObject:payload]) return;

  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (!json || error) return;

  NSMutableData *output = [NSMutableData data];
  [output appendData:[AtomJSEventPrefix dataUsingEncoding:NSUTF8StringEncoding]];
  [output appendData:json];
  [output appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];

  @synchronized([NSFileHandle fileHandleWithStandardOutput]) {
    [[NSFileHandle fileHandleWithStandardOutput] writeData:output];
  }
}

static NSString *AtomJSString(id value, NSString *fallback) {
  return [value isKindOfClass:[NSString class]] ? value : fallback;
}

static NSNumber *AtomJSNumber(id value, NSNumber *fallback) {
  return [value isKindOfClass:[NSNumber class]] ? value : fallback;
}

static BOOL AtomJSBoolean(id value, BOOL fallback) {
  return [value isKindOfClass:[NSNumber class]] ? [value boolValue] : fallback;
}

static NSColor *AtomJSColor(NSString *hex) {
  if (![hex isKindOfClass:[NSString class]]) return [NSColor windowBackgroundColor];

  NSString *value = [hex stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if ([value hasPrefix:@"#"]) value = [value substringFromIndex:1];
  if (value.length != 6 && value.length != 8) return [NSColor windowBackgroundColor];

  unsigned int rgba = 0;
  if (![[NSScanner scannerWithString:value] scanHexInt:&rgba]) return [NSColor windowBackgroundColor];

  CGFloat red;
  CGFloat green;
  CGFloat blue;
  CGFloat alpha = 1.0;

  if (value.length == 8) {
    red = ((rgba >> 24) & 0xff) / 255.0;
    green = ((rgba >> 16) & 0xff) / 255.0;
    blue = ((rgba >> 8) & 0xff) / 255.0;
    alpha = (rgba & 0xff) / 255.0;
  } else {
    red = ((rgba >> 16) & 0xff) / 255.0;
    green = ((rgba >> 8) & 0xff) / 255.0;
    blue = (rgba & 0xff) / 255.0;
  }

  return [NSColor colorWithSRGBRed:red green:green blue:blue alpha:alpha];
}

static void AtomJSConfigureTransparentWebView(WKWebView *webView) {
  if (!webView) return;

  // `drawsBackground` is not exposed as a public Objective-C property by every
  // macOS SDK. Use guarded KVC so older SDKs still compile, while retaining the
  // WebKit behavior needed for genuinely transparent pages.
  @try {
    [webView setValue:@NO forKey:@"drawsBackground"];
  } @catch (__unused NSException *exception) {}

  // Newer WebKit versions expose a public under-page color. Set it through the
  // Objective-C runtime so the host also compiles against SDKs that predate it.
  if ([webView respondsToSelector:NSSelectorFromString(@"setUnderPageBackgroundColor:")]) {
    @try {
      [webView setValue:[NSColor clearColor] forKey:@"underPageBackgroundColor"];
    } @catch (__unused NSException *exception) {}
  }

  webView.wantsLayer = YES;
  webView.layer.backgroundColor = [NSColor clearColor].CGColor;
}

static NSImage *AtomJSDefaultApplicationIcon(void) {
  NSSize size = NSMakeSize(512.0, 512.0);
  NSImage *image = [[NSImage alloc] initWithSize:size];
  [image lockFocus];

  NSRect canvas = NSMakeRect(0.0, 0.0, size.width, size.height);
  NSBezierPath *background = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(canvas, 18.0, 18.0) xRadius:112.0 yRadius:112.0];
  [[NSColor colorWithSRGBRed:0.055 green:0.075 blue:0.11 alpha:1.0] setFill];
  [background fill];

  NSDictionary *letterAttributes = @{
    NSFontAttributeName: [NSFont systemFontOfSize:252.0 weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName: [NSColor colorWithSRGBRed:0.42 green:0.78 blue:1.0 alpha:1.0]
  };
  NSString *letter = @"A";
  NSSize letterSize = [letter sizeWithAttributes:letterAttributes];
  [letter drawAtPoint:NSMakePoint((size.width - letterSize.width) / 2.0, 154.0) withAttributes:letterAttributes];

  NSDictionary *suffixAttributes = @{
    NSFontAttributeName: [NSFont systemFontOfSize:82.0 weight:NSFontWeightMedium],
    NSForegroundColorAttributeName: [NSColor whiteColor]
  };
  NSString *suffix = @"JS";
  NSSize suffixSize = [suffix sizeWithAttributes:suffixAttributes];
  [suffix drawAtPoint:NSMakePoint((size.width - suffixSize.width) / 2.0, 82.0) withAttributes:suffixAttributes];

  [image unlockFocus];
  return image;
}

static void AtomJSConfigureApplicationIdentity(NSApplication *application) {
  [[NSProcessInfo processInfo] setProcessName:atomAppName];

  NSImage *icon = nil;
  if (atomAppIconPath.length > 0) {
    icon = [[NSImage alloc] initWithContentsOfFile:atomAppIconPath];
  }
  application.applicationIconImage = icon ?: AtomJSDefaultApplicationIcon();
}

@interface AtomJSWindowController : NSObject <NSWindowDelegate, WKNavigationDelegate>
@property(nonatomic, strong) NSNumber *windowId;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, weak) AtomJSWindowController *parentController;
@property(nonatomic, assign) BOOL modal;
- (instancetype)initWithWindowId:(NSNumber *)windowId config:(NSDictionary *)config;
- (void)navigate:(NSString *)urlString;
- (void)beginWindowDrag;
@end

@implementation AtomJSWindowController

- (instancetype)initWithWindowId:(NSNumber *)windowId config:(NSDictionary *)config {
  self = [super init];
  if (!self) return nil;

  _windowId = windowId;

  CGFloat width = MAX(320.0, [AtomJSNumber(config[@"width"], @800) doubleValue]);
  CGFloat height = MAX(240.0, [AtomJSNumber(config[@"height"], @600) doubleValue]);
  NSRect frame = NSMakeRect(0, 0, width, height);

  NSWindowStyleMask style = 0;
  if (AtomJSBoolean(config[@"closable"], YES)) style |= NSWindowStyleMaskClosable;
  if (AtomJSBoolean(config[@"minimizable"], YES)) style |= NSWindowStyleMaskMiniaturizable;
  if (AtomJSBoolean(config[@"frame"], YES)) style |= NSWindowStyleMaskTitled;
  if (AtomJSBoolean(config[@"resizable"], YES)) style |= NSWindowStyleMaskResizable;

  NSString *titleBarStyle = AtomJSString(config[@"titleBarStyle"], @"default");
  BOOL usesHiddenTitleBar = [titleBarStyle isEqualToString:@"hidden"]
    || [titleBarStyle isEqualToString:@"hiddenInset"]
    || [titleBarStyle isEqualToString:@"customButtonsOnHover"];
  if (usesHiddenTitleBar) {
    style |= NSWindowStyleMaskFullSizeContentView;
  }

  _window = [[NSWindow alloc]
    initWithContentRect:frame
    styleMask:style
    backing:NSBackingStoreBuffered
    defer:NO];
  _window.releasedWhenClosed = NO;
  _window.delegate = self;
  _window.movable = YES;
  _window.movableByWindowBackground = NO;
  _window.title = AtomJSString(config[@"title"], atomAppName);
  _window.backgroundColor = AtomJSColor(config[@"backgroundColor"]);
  _window.tabbingMode = NSWindowTabbingModeDisallowed;
  _window.alphaValue = MIN(1.0, MAX(0.0, [AtomJSNumber(config[@"opacity"], @1) doubleValue]));
  _window.opaque = !AtomJSBoolean(config[@"transparent"], NO);
  if (!_window.opaque) {
    _window.backgroundColor = [NSColor clearColor];
  }

  if (usesHiddenTitleBar) {
    _window.titleVisibility = NSWindowTitleHidden;
    _window.titlebarAppearsTransparent = YES;
  }

  if (!AtomJSBoolean(config[@"fullscreenable"], YES)) {
    _window.collectionBehavior |= NSWindowCollectionBehaviorFullScreenNone;
  }
  [_window standardWindowButton:NSWindowZoomButton].enabled = AtomJSBoolean(config[@"maximizable"], YES);
  if (AtomJSBoolean(config[@"alwaysOnTop"], NO)) {
    _window.level = NSFloatingWindowLevel;
  }

  CGFloat minWidth = [AtomJSNumber(config[@"minWidth"], @0) doubleValue];
  CGFloat minHeight = [AtomJSNumber(config[@"minHeight"], @0) doubleValue];
  CGFloat maxWidth = [AtomJSNumber(config[@"maxWidth"], @0) doubleValue];
  CGFloat maxHeight = [AtomJSNumber(config[@"maxHeight"], @0) doubleValue];
  if (minWidth > 0 || minHeight > 0) {
    _window.contentMinSize = NSMakeSize(MAX(1.0, minWidth), MAX(1.0, minHeight));
  }
  if (maxWidth > 0 || maxHeight > 0) {
    _window.contentMaxSize = NSMakeSize(maxWidth > 0 ? maxWidth : CGFLOAT_MAX, maxHeight > 0 ? maxHeight : CGFLOAT_MAX);
  }

  if ([config[@"x"] isKindOfClass:[NSNumber class]] && [config[@"y"] isKindOfClass:[NSNumber class]]) {
    [_window setFrameOrigin:NSMakePoint([config[@"x"] doubleValue], [config[@"y"] doubleValue])];
  } else if (AtomJSBoolean(config[@"center"], YES)) {
    [_window center];
  }

  WKUserContentController *contentController = [[WKUserContentController alloc] init];
  NSString *bridgeScript = AtomJSString(config[@"bridgeScript"], @"");
  if (bridgeScript.length > 0) {
    WKUserScript *script = [[WKUserScript alloc]
      initWithSource:bridgeScript
      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
      forMainFrameOnly:YES];
    [contentController addUserScript:script];
  }

  WKWebViewConfiguration *webConfiguration = [[WKWebViewConfiguration alloc] init];
  webConfiguration.userContentController = contentController;

  _webView = [[WKWebView alloc] initWithFrame:frame configuration:webConfiguration];
  _webView.navigationDelegate = self;
  _webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  if (AtomJSBoolean(config[@"transparent"], NO)) AtomJSConfigureTransparentWebView(_webView);
  _window.contentView = _webView;

  NSNumber *parentWindowId = AtomJSNumber(config[@"parentWindowId"], nil);
  _parentController = parentWindowId ? atomWindows[parentWindowId] : nil;
  _modal = AtomJSBoolean(config[@"modal"], NO) && _parentController != nil;

  NSDictionary *trafficLightPosition = [config[@"trafficLightPosition"] isKindOfClass:[NSDictionary class]]
    ? config[@"trafficLightPosition"]
    : nil;
  if (trafficLightPosition) {
    CGFloat x = [AtomJSNumber(trafficLightPosition[@"x"], @0) doubleValue];
    CGFloat y = [AtomJSNumber(trafficLightPosition[@"y"], @0) doubleValue];
    NSButton *closeButton = [_window standardWindowButton:NSWindowCloseButton];
    NSView *container = closeButton.superview;
    if (container) {
      NSPoint origin = container.frame.origin;
      origin.x = x;
      origin.y = MAX(0.0, _window.frame.size.height - container.frame.size.height - y);
      [container setFrameOrigin:origin];
    }
  }

  [self navigate:AtomJSString(config[@"url"], @"about:blank")];

  if (AtomJSBoolean(config[@"show"], YES)) {
    [NSApp unhide:nil];
    if (_modal) {
      [_parentController.window beginSheet:_window completionHandler:nil];
    } else {
      if (_parentController) [_parentController.window addChildWindow:_window ordered:NSWindowAbove];
      [_window makeKeyAndOrderFront:nil];
      [_window orderFrontRegardless];
    }
    [NSApp activateIgnoringOtherApps:YES];
  }

  return self;
}

- (void)beginWindowDrag {
  if (!self.window || ([NSEvent pressedMouseButtons] & 1) == 0) return;

  NSPoint screenLocation = [NSEvent mouseLocation];
  NSPoint windowLocation = [self.window convertPointFromScreen:screenLocation];
  NSEvent *mouseDown = [NSEvent
    mouseEventWithType:NSEventTypeLeftMouseDown
    location:windowLocation
    modifierFlags:0
    timestamp:[[NSProcessInfo processInfo] systemUptime]
    windowNumber:self.window.windowNumber
    context:nil
    eventNumber:0
    clickCount:1
    pressure:1.0];

  if (mouseDown) [self.window performWindowDragWithEvent:mouseDown];
}

- (void)navigate:(NSString *)urlString {
  NSURL *url = [NSURL URLWithString:urlString ?: @"about:blank"];
  if (!url) {
    AtomJSEmit(@{
      @"type": @"did-fail-load",
      @"windowId": self.windowId,
      @"url": urlString ?: @"",
      @"error": @"Invalid URL"
    });
    return;
  }

  [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (NSString *)currentURL {
  return self.webView.URL.absoluteString ?: @"";
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
  AtomJSEmit(@{
    @"type": @"did-start-loading",
    @"windowId": self.windowId,
    @"url": [self currentURL]
  });
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  AtomJSEmit(@{
    @"type": @"did-finish-load",
    @"windowId": self.windowId,
    @"url": [self currentURL]
  });
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  AtomJSEmit(@{
    @"type": @"did-fail-load",
    @"windowId": self.windowId,
    @"url": [self currentURL],
    @"error": error.localizedDescription ?: @"Navigation failed"
  });
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  [self webView:webView didFailNavigation:navigation withError:error];
}

- (void)windowWillClose:(NSNotification *)notification {
  if (self.parentController) {
    if (self.modal && self.window.sheetParent) {
      [self.window.sheetParent endSheet:self.window];
    } else {
      [self.parentController.window removeChildWindow:self.window];
    }
  }
  [atomWindows removeObjectForKey:self.windowId];
  AtomJSEmit(@{
    @"type": @"closed",
    @"windowId": self.windowId
  });
}

- (void)windowDidBecomeKey:(NSNotification *)notification {
  AtomJSEmit(@{
    @"type": @"focus",
    @"windowId": self.windowId
  });
}

- (void)windowDidResignKey:(NSNotification *)notification {
  AtomJSEmit(@{
    @"type": @"blur",
    @"windowId": self.windowId
  });
}

- (void)windowDidMiniaturize:(NSNotification *)notification {
  AtomJSEmit(@{
    @"type": @"minimize",
    @"windowId": self.windowId
  });
}

- (void)windowDidDeminiaturize:(NSNotification *)notification {
  AtomJSEmit(@{
    @"type": @"restore",
    @"windowId": self.windowId
  });
}

@end

static AtomJSWindowController *AtomJSController(NSDictionary *message) {
  NSNumber *windowId = AtomJSNumber(message[@"windowId"], nil);
  return windowId ? atomWindows[windowId] : nil;
}

static NSArray<NSString *> *AtomJSAllowedExtensions(NSDictionary *options) {
  NSArray *filters = [options[@"filters"] isKindOfClass:[NSArray class]] ? options[@"filters"] : @[];
  NSMutableArray<NSString *> *extensions = [NSMutableArray array];

  for (id filter in filters) {
    if (![filter isKindOfClass:[NSDictionary class]]) continue;
    NSArray *items = [filter[@"extensions"] isKindOfClass:[NSArray class]] ? filter[@"extensions"] : @[];
    for (id item in items) {
      if ([item isKindOfClass:[NSString class]] && ![item isEqualToString:@"*"]) {
        [extensions addObject:item];
      }
    }
  }

  return extensions;
}

static void AtomJSRespond(NSString *requestId, BOOL ok, id result, NSString *error) {
  if (!requestId) return;

  NSMutableDictionary *response = [@{
    @"type": @"response",
    @"requestId": requestId,
    @"ok": @(ok)
  } mutableCopy];

  if (result) response[@"result"] = result;
  if (error) response[@"error"] = error;
  AtomJSEmit(response);
}

static NSDictionary *AtomJSOpenDialog(NSDictionary *options) {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = AtomJSString(options[@"title"], @"");
  panel.prompt = AtomJSString(options[@"buttonLabel"], panel.prompt);

  NSArray *properties = [options[@"properties"] isKindOfClass:[NSArray class]] ? options[@"properties"] : @[];
  panel.allowsMultipleSelection = [properties containsObject:@"multiSelections"];
  panel.canChooseDirectories = [properties containsObject:@"openDirectory"];
  panel.canChooseFiles = !panel.canChooseDirectories || [properties containsObject:@"openFile"];
  panel.canCreateDirectories = [properties containsObject:@"createDirectory"];

  NSString *defaultPath = AtomJSString(options[@"defaultPath"], nil);
  if (defaultPath.length > 0) {
    BOOL isDirectory = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:defaultPath isDirectory:&isDirectory]) {
      panel.directoryURL = [NSURL fileURLWithPath:isDirectory ? defaultPath : [defaultPath stringByDeletingLastPathComponent]];
    }
  }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSArray *extensions = AtomJSAllowedExtensions(options);
  if (extensions.count > 0) panel.allowedFileTypes = extensions;
#pragma clang diagnostic pop

  NSModalResponse response = [panel runModal];
  if (response != NSModalResponseOK) {
    return @{ @"canceled": @YES, @"filePaths": @[] };
  }

  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  for (NSURL *url in panel.URLs) {
    if (url.path) [paths addObject:url.path];
  }
  return @{ @"canceled": @(paths.count == 0), @"filePaths": paths };
}

static NSDictionary *AtomJSSaveDialog(NSDictionary *options) {
  NSSavePanel *panel = [NSSavePanel savePanel];
  panel.title = AtomJSString(options[@"title"], @"");
  panel.prompt = AtomJSString(options[@"buttonLabel"], panel.prompt);
  panel.canCreateDirectories = YES;

  NSString *defaultPath = AtomJSString(options[@"defaultPath"], nil);
  if (defaultPath.length > 0) {
    panel.directoryURL = [NSURL fileURLWithPath:[defaultPath stringByDeletingLastPathComponent]];
    panel.nameFieldStringValue = [defaultPath lastPathComponent];
  }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSArray *extensions = AtomJSAllowedExtensions(options);
  if (extensions.count > 0) panel.allowedFileTypes = extensions;
#pragma clang diagnostic pop

  NSModalResponse response = [panel runModal];
  if (response != NSModalResponseOK || !panel.URL.path) {
    return @{ @"canceled": @YES };
  }

  return @{ @"canceled": @NO, @"filePath": panel.URL.path };
}

static NSDictionary *AtomJSMessageDialog(NSDictionary *options) {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = AtomJSString(options[@"message"], atomAppName);
  alert.informativeText = AtomJSString(options[@"detail"], @"");

  NSString *type = AtomJSString(options[@"type"], @"none");
  if ([type isEqualToString:@"error"]) alert.alertStyle = NSAlertStyleCritical;
  else if ([type isEqualToString:@"warning"]) alert.alertStyle = NSAlertStyleWarning;
  else alert.alertStyle = NSAlertStyleInformational;

  NSArray *buttons = [options[@"buttons"] isKindOfClass:[NSArray class]] ? options[@"buttons"] : @[];
  if (buttons.count == 0) buttons = @[ @"OK" ];
  for (id button in buttons) {
    [alert addButtonWithTitle:AtomJSString(button, @"OK")];
  }

  NSString *checkboxLabel = AtomJSString(options[@"checkboxLabel"], nil);
  NSButton *checkbox = nil;
  if (checkboxLabel.length > 0) {
    checkbox = [NSButton checkboxWithTitle:checkboxLabel target:nil action:nil];
    checkbox.state = AtomJSBoolean(options[@"checkboxChecked"], NO) ? NSControlStateValueOn : NSControlStateValueOff;
    alert.accessoryView = checkbox;
  }

  NSModalResponse response = [alert runModal];
  NSInteger index = MAX(0, response - NSAlertFirstButtonReturn);
  return @{
    @"response": @(index),
    @"checkboxChecked": @(checkbox && checkbox.state == NSControlStateValueOn)
  };
}

static void AtomJSHandleMessage(NSDictionary *message) {
  NSString *command = AtomJSString(message[@"command"], @"");
  NSString *requestId = AtomJSString(message[@"requestId"], nil);

  if ([command isEqualToString:@"create"]) {
    NSNumber *windowId = AtomJSNumber(message[@"windowId"], nil);
    NSDictionary *config = [message[@"config"] isKindOfClass:[NSDictionary class]] ? message[@"config"] : @{};
    if (!windowId) {
      AtomJSRespond(requestId, NO, nil, @"The create command did not include a valid window ID.");
      return;
    }

    AtomJSWindowController *controller = [[AtomJSWindowController alloc] initWithWindowId:windowId config:config];
    if (!controller || !controller.window || !controller.webView) {
      AtomJSRespond(requestId, NO, nil, @"AppKit could not create the AtomJS window.");
      return;
    }

    atomWindows[windowId] = controller;
    AtomJSRespond(requestId, YES, @{ @"windowId": windowId }, nil);
    AtomJSEmit(@{
      @"type": @"created",
      @"windowId": windowId
    });
    return;
  }

  if ([command isEqualToString:@"dialog-open"]) {
    AtomJSRespond(requestId, YES, AtomJSOpenDialog([message[@"options"] isKindOfClass:[NSDictionary class]] ? message[@"options"] : @{}), nil);
    return;
  }

  if ([command isEqualToString:@"dialog-save"]) {
    AtomJSRespond(requestId, YES, AtomJSSaveDialog([message[@"options"] isKindOfClass:[NSDictionary class]] ? message[@"options"] : @{}), nil);
    return;
  }

  if ([command isEqualToString:@"dialog-message"]) {
    AtomJSRespond(requestId, YES, AtomJSMessageDialog([message[@"options"] isKindOfClass:[NSDictionary class]] ? message[@"options"] : @{}), nil);
    return;
  }

  if ([command isEqualToString:@"quit"]) {
    [NSApp terminate:nil];
    return;
  }

  AtomJSWindowController *controller = AtomJSController(message);
  if (!controller) {
    AtomJSRespond(requestId, NO, nil, @"Unknown AtomJS window.");
    return;
  }

  if ([command isEqualToString:@"navigate"]) {
    [controller navigate:AtomJSString(message[@"url"], @"about:blank")];
  } else if ([command isEqualToString:@"show"]) {
    [NSApp unhide:nil];
    [controller.window makeKeyAndOrderFront:nil];
    [controller.window orderFrontRegardless];
    [NSApp activateIgnoringOtherApps:YES];
  } else if ([command isEqualToString:@"hide"]) {
    [controller.window orderOut:nil];
  } else if ([command isEqualToString:@"focus"]) {
    [NSApp unhide:nil];
    [controller.window makeKeyAndOrderFront:nil];
    [controller.window orderFrontRegardless];
    [NSApp activateIgnoringOtherApps:YES];
  } else if ([command isEqualToString:@"start-drag"]) {
    [controller beginWindowDrag];
  } else if ([command isEqualToString:@"close"] || [command isEqualToString:@"destroy"]) {
    [controller.window close];
  } else if ([command isEqualToString:@"set-title"]) {
    controller.window.title = AtomJSString(message[@"title"], atomAppName);
  } else if ([command isEqualToString:@"minimize"]) {
    [controller.window miniaturize:nil];
  } else if ([command isEqualToString:@"restore"]) {
    [controller.window deminiaturize:nil];
    [controller.window makeKeyAndOrderFront:nil];
  } else if ([command isEqualToString:@"maximize"]) {
    if (!controller.window.zoomed) [controller.window zoom:nil];
  } else if ([command isEqualToString:@"unmaximize"]) {
    if (controller.window.zoomed) [controller.window zoom:nil];
  } else if ([command isEqualToString:@"fullscreen"]) {
    BOOL requested = AtomJSBoolean(message[@"value"], YES);
    BOOL active = (controller.window.styleMask & NSWindowStyleMaskFullScreen) == NSWindowStyleMaskFullScreen;
    if (requested != active) [controller.window toggleFullScreen:nil];
  } else if ([command isEqualToString:@"set-bounds"]) {
    NSDictionary *bounds = [message[@"bounds"] isKindOfClass:[NSDictionary class]] ? message[@"bounds"] : @{};
    NSRect frame = controller.window.frame;
    if ([bounds[@"x"] isKindOfClass:[NSNumber class]]) frame.origin.x = [bounds[@"x"] doubleValue];
    if ([bounds[@"y"] isKindOfClass:[NSNumber class]]) frame.origin.y = [bounds[@"y"] doubleValue];
    if ([bounds[@"width"] isKindOfClass:[NSNumber class]]) frame.size.width = MAX(1.0, [bounds[@"width"] doubleValue]);
    if ([bounds[@"height"] isKindOfClass:[NSNumber class]]) frame.size.height = MAX(1.0, [bounds[@"height"] doubleValue]);
    [controller.window setFrame:frame display:YES animate:NO];
  } else if ([command isEqualToString:@"set-always-on-top"]) {
    controller.window.level = AtomJSBoolean(message[@"value"], NO) ? NSFloatingWindowLevel : NSNormalWindowLevel;
  } else if ([command isEqualToString:@"set-opacity"]) {
    controller.window.alphaValue = MIN(1.0, MAX(0.0, [AtomJSNumber(message[@"value"], @1) doubleValue]));
  } else if ([command isEqualToString:@"set-resizable"]) {
    BOOL requested = AtomJSBoolean(message[@"value"], YES);
    if (requested) controller.window.styleMask |= NSWindowStyleMaskResizable;
    else controller.window.styleMask &= ~NSWindowStyleMaskResizable;
  } else {
    AtomJSRespond(requestId, NO, nil, [NSString stringWithFormat:@"Unsupported AtomJS native command: %@", command]);
    return;
  }

  AtomJSRespond(requestId, YES, @{}, nil);
}

static void AtomJSConsumeInput(void) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSMutableData *buffer = [NSMutableData data];

    while (YES) {
      @autoreleasepool {
        unsigned char bytes[4096];
        ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (count < 0) {
          if (errno == EINTR) continue;
          AtomJSEmit(@{
            @"type": @"host-error",
            @"error": [NSString stringWithFormat:@"Could not read native-host input: %s", strerror(errno)]
          });
          break;
        }
        if (count == 0) break;
        [buffer appendBytes:bytes length:(NSUInteger)count];

        while (YES) {
          const unsigned char *bytes = buffer.bytes;
          NSUInteger newline = NSNotFound;
          for (NSUInteger index = 0; index < buffer.length; index += 1) {
            if (bytes[index] == '\n') {
              newline = index;
              break;
            }
          }

          if (newline == NSNotFound) break;

          NSData *lineData = [buffer subdataWithRange:NSMakeRange(0, newline)];
          [buffer replaceBytesInRange:NSMakeRange(0, newline + 1) withBytes:NULL length:0];
          if (lineData.length == 0) continue;

          NSError *error = nil;
          id value = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:&error];
          if (![value isKindOfClass:[NSDictionary class]] || error) continue;

          NSDictionary *message = value;
          dispatch_async(dispatch_get_main_queue(), ^{
            AtomJSHandleMessage(message);
          });
        }
      }
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      [NSApp terminate:nil];
    });
  });
}

static void AtomJSInstallMenu(void) {
  NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];
  NSMenuItem *applicationItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [mainMenu addItem:applicationItem];

  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:atomAppName];
  NSString *quitTitle = [NSString stringWithFormat:@"Quit %@", atomAppName];
  NSMenuItem *quitItem = [[NSMenuItem alloc]
    initWithTitle:quitTitle
    action:@selector(terminate:)
    keyEquivalent:@"q"];
  [applicationMenu addItem:quitItem];
  applicationItem.submenu = applicationMenu;
  NSApp.mainMenu = mainMenu;
}

@interface AtomJSApplicationDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AtomJSApplicationDelegate

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
  AtomJSConfigureApplicationIdentity(NSApp);
  AtomJSInstallMenu();
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  AtomJSConsumeInput();
  AtomJSEmit(@{
    @"type": @"ready",
    @"pid": @([[NSProcessInfo processInfo] processIdentifier]),
    @"appName": atomAppName,
    @"appId": atomAppIdentifier
  });
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return NO;
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    for (int index = 1; index + 1 < argc; index += 1) {
      if (strcmp(argv[index], "--app-name") == 0) {
        atomAppName = [NSString stringWithUTF8String:argv[index + 1]] ?: @"AtomJS App";
        index += 1;
      } else if (strcmp(argv[index], "--app-id") == 0) {
        atomAppIdentifier = [NSString stringWithUTF8String:argv[index + 1]] ?: @"com.atomjs.app";
        index += 1;
      } else if (strcmp(argv[index], "--app-icon") == 0) {
        atomAppIconPath = [NSString stringWithUTF8String:argv[index + 1]];
        index += 1;
      }
    }

    [[NSProcessInfo processInfo] setProcessName:atomAppName];
    atomWindows = [NSMutableDictionary dictionary];
    NSApplication *application = [NSApplication sharedApplication];
    AtomJSApplicationDelegate *delegate = [[AtomJSApplicationDelegate alloc] init];
    application.delegate = delegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application run];
  }

  return 0;
}
