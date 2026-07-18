# Roadmap

## 0.3 native macOS application

- one shared Cocoa/WKWebView host per application
- native window controls and dialogs without `osascript`
- embedded macOS application payload
- signed and verified `.app`, ZIP, and DMG output

## 0.4 shared Windows and Linux hosts

- one WebView2 host per Windows application
- one WebKitGTK host per Linux application
- embedded payloads without loose application source directories
- native menu, tray, shortcuts and notifications

## 0.5 distribution

- Windows signing
- macOS Developer ID signing and notarization
- Linux deb/rpm packages
- delta updates
- release publishing

## 1.0

- stable API compatibility table
- automated WebView compatibility tests
- hardened navigation and permission policy
- long-term support release process
