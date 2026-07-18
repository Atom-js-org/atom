/// <reference types="node" />

import { EventEmitter } from 'node:events';

export interface BrowserWindowConstructorOptions {
  width?: number;
  height?: number;
  title?: string;
  show?: boolean;
  resizable?: boolean;
  center?: boolean;
  frame?: boolean;
  backgroundColor?: string;
  webPreferences?: {
    preload?: string;
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    devTools?: boolean;
  };
}

export class WebContents extends EventEmitter {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  reload(): void;
  loadURL(url: string): void;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getURL(): string;
  isDestroyed(): boolean;
}

export class BrowserWindow extends EventEmitter {
  constructor(options?: BrowserWindowConstructorOptions);
  readonly id: number;
  readonly webContents: WebContents;
  loadFile(filePath: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  isVisible(): boolean;
  focus(): void;
  blur(): void;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  setTitle(title: string): void;
  getTitle(): string;
  setMenu(menu: Menu | null): this;
  getMenu(): Menu | null;
  removeMenu(): void;
  setMenuBarVisibility(visible: boolean): void;
  isMenuBarVisible(): boolean;
  setAutoHideMenuBar(hide: boolean): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  minimize(): void;
  restore(): void;
  isMinimized(): boolean;
  setSize(width: number, height: number): void;
  getSize(): [number, number];
  setBounds(bounds: { x?: number; y?: number; width?: number; height?: number }): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  reload(): void;
  static getAllWindows(): BrowserWindow[];
  static fromId(id: number): BrowserWindow | null;
  static getFocusedWindow(): BrowserWindow | null;
}

export const app: EventEmitter & {
  whenReady(): Promise<typeof app>;
  isReady(): boolean;
  quit(): Promise<void>;
  exit(exitCode?: number): never;
  getName(): string;
  setName(name: string): void;
  getVersion(): string;
  getAppPath(): string;
  getPath(name: string): string;
};

export const ipcMain: EventEmitter & {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  handleOnce(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
};

export const dialog: {
  showOpenDialog(options?: object): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options?: object): Promise<{ canceled: boolean; filePath?: string }>;
  showMessageBox(options?: object): Promise<{ response: number; checkboxChecked: boolean }>;
};

export const shell: {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;
  showItemInFolder(fullPath: string): void;
};

export const clipboard: {
  writeText(text: string): void;
  readText(): string;
};

export class Menu {
  items: MenuItem[];
  append(item: MenuItem | object): void;
  popup(): void;
  static buildFromTemplate(template: object[]): Menu;
  static setApplicationMenu(menu: Menu | null): void;
  static getApplicationMenu(): Menu | null;
}

export class MenuItem {
  constructor(options?: object);
}

export class Tray {
  constructor(image: unknown);
}

export const nativeTheme: {
  readonly shouldUseDarkColors: boolean;
  themeSource: 'system' | 'light' | 'dark';
};


export class Notification extends EventEmitter {
  constructor(options?: { title?: string; body?: string; [key: string]: unknown });
  show(): void;
  close(): void;
  static isSupported(): boolean;
}

export const session: any;
export const protocol: any;
export const net: any;
export const screen: any;
export const webContents: any;
export const nativeImage: any;
export const globalShortcut: any;
export const powerSaveBlocker: any;
export const powerMonitor: any;
export const systemPreferences: any;
export const safeStorage: any;
export const desktopCapturer: any;
export const crashReporter: any;
export const autoUpdater: any;
export const contentTracing: any;
export const netLog: any;
export const utilityProcess: any;
export const pushNotifications: any;
export const inAppPurchase: any;
export class BrowserView extends EventEmitter {}
export class WebContentsView extends BrowserView {}
export class BaseWindow extends BrowserWindow {}
export class View extends EventEmitter {}
export class ImageView extends View {}
export class MessageChannelMain { port1: any; port2: any; }
export const MessagePortMain: any;
export const TouchBar: any;
