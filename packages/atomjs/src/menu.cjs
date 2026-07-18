'use strict';

class Menu {
  constructor() {
    this.items = [];
  }

  append(item) {
    this.items.push(item instanceof MenuItem ? item : new MenuItem(item));
  }

  popup() {
    console.warn('[AtomJS] Native menus are planned but not implemented in this alpha runtime.');
  }

  static buildFromTemplate(template) {
    const menu = new Menu();
    for (const item of template || []) menu.append(item);
    return menu;
  }

  static setApplicationMenu(menu) {
    Menu.applicationMenu = menu;
    console.warn('[AtomJS] Application menus are stored for compatibility but are not native yet.');
  }

  static getApplicationMenu() {
    return Menu.applicationMenu || null;
  }
}

class MenuItem {
  constructor(options = {}) {
    Object.assign(this, options);
    this.label = options.label || '';
    this.enabled = options.enabled !== false;
    this.visible = options.visible !== false;
  }
}

class Tray {
  constructor(image) {
    this.image = image;
    throw new Error('Tray is not implemented in AtomJS alpha. It requires a native platform adapter.');
  }
}

module.exports = { Menu, MenuItem, Tray };
