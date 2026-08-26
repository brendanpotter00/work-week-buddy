/**
 * A hand-written `electron` double.
 *
 * `import { Tray } from "electron"` outside a real Electron process resolves to
 * a module whose default export is a PATH STRING, so every named import is
 * `undefined` and the failure arrives several frames away from its cause. This
 * module is substituted with `vi.mock("electron", …)` so `src/main/` can be
 * unit-tested in a plain Node process — no Electron binary, no window server,
 * no TCC grant.
 *
 * Only the surface `src/main/` actually touches is modelled. A test that needs
 * more should add it here rather than reaching into Electron internals.
 */

export interface Recorded {
  channel: string;
  payload: unknown;
}

class Emitter {
  readonly handlers = new Map<string, Array<(...a: never[]) => void>>();
  on(event: string, cb: (...a: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  once(event: string, cb: (...a: never[]) => void): this {
    return this.on(event, cb);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }
}

export class FakeNativeImage {
  constructor(readonly path: string) {}
  isEmpty(): boolean {
    return this.path === "";
  }
  setTemplateImage(): void {
    /* recorded by identity, not needed */
  }
}

export const nativeImage = {
  /** Every icon path resolves to a non-empty image so the tray keeps its name. */
  createFromPath: (p: string) => new FakeNativeImage(p),
  createEmpty: () => new FakeNativeImage(""),
};

export class Tray extends Emitter {
  static instances: Tray[] = [];
  title = "";
  titleOptions: unknown = null;
  tooltip = "";
  image: FakeNativeImage;
  destroyed = false;
  poppedMenus: unknown[] = [];
  /** Every title ever set, in order. The tray's whole job, as an array. */
  readonly titles: string[] = [];
  readonly images: string[] = [];

  constructor(image: FakeNativeImage) {
    super();
    this.image = image;
    Tray.instances.push(this);
  }
  setTitle(title: string, options?: unknown): void {
    this.title = title;
    this.titleOptions = options ?? null;
    this.titles.push(title);
  }
  getTitle(): string {
    return this.title;
  }
  setToolTip(t: string): void {
    this.tooltip = t;
  }
  setImage(img: FakeNativeImage): void {
    this.image = img;
    this.images.push(img.path);
  }
  setIgnoreDoubleClickEvents(): void {
    /* no-op */
  }
  popUpContextMenu(menu: unknown): void {
    this.poppedMenus.push(menu);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export const Menu = {
  applicationMenu: null as unknown,
  buildFromTemplate: (template: unknown) => ({ template }),
  setApplicationMenu(m: unknown): void {
    Menu.applicationMenu = m;
  },
  getApplicationMenu: () => Menu.applicationMenu,
};

export interface FakeWindow {
  destroyed: boolean;
  sent: Recorded[];
  /** Zoom state, for `wwb:window:zoom` (double-click on the title bar). */
  maximized: boolean;
  maximizable: boolean;
  zoomCalls: string[];
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void };
  isMaximizable(): boolean;
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  destroy(): void;
}

const windows: FakeWindow[] = [];

export function addFakeWindow(over: { maximizable?: boolean } = {}): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    sent: [],
    maximized: false,
    maximizable: over.maximizable ?? true,
    zoomCalls: [],
    isDestroyed: () => win.destroyed,
    webContents: {
      isDestroyed: () => win.destroyed,
      send: (channel, payload) => win.sent.push({ channel, payload }),
    },
    isMaximizable: () => win.maximizable,
    isMaximized: () => win.maximized,
    maximize: () => {
      win.maximized = true;
      win.zoomCalls.push("maximize");
    },
    unmaximize: () => {
      win.maximized = false;
      win.zoomCalls.push("unmaximize");
    },
    destroy: () => {
      win.destroyed = true;
      const i = windows.indexOf(win);
      if (i >= 0) windows.splice(i, 1);
    },
  };
  windows.push(win);
  return win;
}

export const BrowserWindow = {
  getAllWindows: (): FakeWindow[] => windows.filter((w) => !w.destroyed),
  /**
   * `wwb:window:zoom` scopes itself to the window that asked, so the fake has
   * to be able to answer "which window is this sender in?" too. `senderEvent`
   * carries the `webContents` object identity; this looks it up.
   */
  fromWebContents: (wc: unknown): FakeWindow | null =>
    windows.find((w) => w.webContents === wc) ?? null,
};

export type InvokeHandler = (e: unknown, payload: unknown) => unknown;

export const ipcMain = {
  handlers: new Map<string, InvokeHandler>(),
  handle(channel: string, fn: InvokeHandler): void {
    ipcMain.handlers.set(channel, fn);
  },
  removeHandler(channel: string): void {
    ipcMain.handlers.delete(channel);
  },
};

/**
 * An `IpcMainInvokeEvent` with the two things main reads off it: the frame URL
 * the sender guard checks, and the `sender` that `BrowserWindow.fromWebContents`
 * resolves back to a window.
 */
export function senderEvent(
  url: string,
  from?: FakeWindow,
): { senderFrame: { url: string }; sender: unknown } {
  return { senderFrame: { url }, sender: from?.webContents ?? null };
}

export const appEvents = new Emitter();

export const app = {
  name: "Work Week Buddy",
  isPackaged: false,
  /** `net.fetch` does not exist before this is true. See `src/main/net.ts`. */
  ready: true,
  exitCode: null as number | null,
  quitCalls: 0,
  relaunchCalls: 0,
  userDataDir: "/tmp/wwb-test",
  on: (event: string, cb: (...a: never[]) => void) => appEvents.on(event, cb),
  emit: (event: string, ...args: unknown[]) => appEvents.emit(event, ...args),
  getPath: () => app.userDataDir,
  getAppPath: () => "/tmp/wwb-app",
  getVersion: () => "0.1.0-test",
  setName: (n: string) => {
    app.name = n;
  },
  isReady: () => app.ready,
  requestSingleInstanceLock: () => true,
  dock: { hide: () => undefined },
  exit: (code: number) => {
    app.exitCode = code;
  },
  quit: () => {
    app.quitCalls++;
  },
  relaunch: () => {
    app.relaunchCalls++;
  },
};

export const shell = {
  opened: [] as string[],
  openExternal: async (url: string) => {
    shell.opened.push(url);
  },
};

export const dialog = {
  errors: [] as Array<{ title: string; content: string }>,
  messageBoxes: [] as unknown[],
  nextAnswer: { response: 0, checkboxChecked: false },
  showErrorBox(title: string, content: string): void {
    dialog.errors.push({ title, content });
  },
  async showMessageBox(opts: unknown) {
    dialog.messageBoxes.push(opts);
    return dialog.nextAnswer;
  },
};

export const powerMonitor = new Emitter();

export const protocol = {
  privileged: [] as unknown[],
  handlers: new Map<string, unknown>(),
  registerSchemesAsPrivileged(s: unknown): void {
    protocol.privileged.push(s);
  },
  handle(scheme: string, fn: unknown): void {
    protocol.handlers.set(scheme, fn);
  },
};

export const net = {
  calls: [] as Array<{ input: unknown; init: unknown }>,
  nextStatus: 200,
  fetch: async (input?: unknown, init?: unknown) => {
    net.calls.push({ input, init });
    return new Response("", { status: net.nextStatus });
  },
};

export const contextBridge = {
  exposed: new Map<string, unknown>(),
  exposeInMainWorld(key: string, value: unknown): void {
    contextBridge.exposed.set(key, value);
  },
};

export const ipcRenderer = {
  invoked: [] as Recorded[],
  listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
  async invoke(channel: string, payload: unknown) {
    ipcRenderer.invoked.push({ channel, payload });
    return null;
  },
  on(channel: string, listener: (...a: unknown[]) => void): void {
    const list = ipcRenderer.listeners.get(channel) ?? [];
    list.push(listener);
    ipcRenderer.listeners.set(channel, list);
  },
  removeListener(channel: string, listener: (...a: unknown[]) => void): void {
    const list = ipcRenderer.listeners.get(channel) ?? [];
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  },
};

/** Call in `beforeEach`. Module state is shared across a file's tests. */
export function resetElectronMock(): void {
  Tray.instances = [];
  Menu.applicationMenu = null;
  windows.length = 0;
  ipcMain.handlers.clear();
  appEvents.handlers.clear();
  powerMonitor.handlers.clear();
  app.exitCode = null;
  app.quitCalls = 0;
  app.relaunchCalls = 0;
  app.isPackaged = false;
  shell.opened.length = 0;
  dialog.errors.length = 0;
  dialog.messageBoxes.length = 0;
  dialog.nextAnswer = { response: 0, checkboxChecked: false };
  protocol.privileged.length = 0;
  protocol.handlers.clear();
  contextBridge.exposed.clear();
  ipcRenderer.invoked.length = 0;
  ipcRenderer.listeners.clear();
}
