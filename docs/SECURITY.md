# Security model

- Renderer pages do not receive Node.js directly.
- `nodeIntegration` is always false.
- Preload scripts receive only AtomJS `contextBridge` and `ipcRenderer` compatibility objects.
- Privileged operations remain in the Node.js main process.
- Local static files are constrained to the BrowserWindow content root.
- Bridge traffic is authenticated with a random process token and bound to loopback.
- IPC channel names and argument validation remain the application developer's responsibility.

Do not load untrusted remote pages with a preload that exposes powerful write, shell, credential, or filesystem operations. Treat every exposed function as a public security boundary.
