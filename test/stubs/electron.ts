// Minimal `electron` stub for the vitest node run. The main modules under test import
// `electron` transitively (e.g. logger.ts → app.getPath), but there is no electron runtime in plain
// Node. vitest aliases the bare `electron` specifier to this file (see vitest.config.ts), so those
// imports resolve to inert no-ops. It exposes only what the tested import graph touches; extend as
// the test surface grows.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = path.join(os.tmpdir(), 'playhook-test-userdata');

export const app = {
  getPath(name: string): string {
    return path.join(userData, name);
  },
  getVersion(): string {
    return '0.0.0-test';
  },
};

/**
 * `Menu.buildFromTemplate` hands the template straight back, so tray.ts's `buildTrayMenu` — a pure
 * function whose whole value is being assertable — can be inspected item by item (test/tray.test.ts).
 * Electron's real Menu exposes no such view.
 */
export const Menu = {
  buildFromTemplate(template: readonly unknown[]): readonly unknown[] {
    return template;
  },
};

/**
 * `nativeImage` stand-in for LibraryStore's lazy thumbnail path (test/library-store.test.ts). The real one
 * decodes PNG/JPEG only, and the store's fallbacks hinge on that, so the stub keeps the same contract with
 * a trivial "format": a file whose first bytes are `IMG <width>x<height>` decodes, anything else is empty.
 * resize/toJPEG/toPNG produce recognizable byte strings so a test can tell which branch ran.
 */
export const nativeImage = {
  createFromPath(filePath: string): NativeImageStub {
    let text = '';
    try {
      text = fsSync.readFileSync(filePath, 'utf8');
    } catch {
      text = '';
    }
    const match = /^IMG (\d+)x(\d+)/.exec(text);
    if (match === null) return makeImage(null);
    return makeImage({ width: Number(match[1]), height: Number(match[2]) });
  },
  createEmpty(): NativeImageStub {
    return makeImage(null);
  },
};

interface NativeImageStub {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { height?: number; width?: number }): NativeImageStub;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
}

function makeImage(size: { width: number; height: number } | null): NativeImageStub {
  const current = size ?? { width: 0, height: 0 };
  return {
    isEmpty: () => size === null,
    getSize: () => current,
    resize: ({ height }) => makeImage({ width: current.width, height: height ?? current.height }),
    toJPEG: (quality) => Buffer.from(`JPEG ${current.width}x${current.height} q${quality}`),
    toPNG: () => Buffer.from(`PNG ${current.width}x${current.height}`),
  };
}

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

const ipcHandlers = new Map<string, IpcListener>();
const ipcListeners = new Map<string, IpcListener>();

/**
 * `ipcMain` records what a service registers instead of wiring anything, so a test can pick the handler
 * of one channel out of `handlers` / `listeners` and call it the way the renderer would
 * (test/game-controller.test.ts). A later registration on the same channel replaces the earlier one —
 * every test builds its own service, and the last one built is the one under test.
 */
export const ipcMain = {
  handlers: ipcHandlers,
  listeners: ipcListeners,
  handle(channel: string, handler: IpcListener): void {
    ipcHandlers.set(channel, handler);
  },
  on(channel: string, listener: IpcListener): void {
    ipcListeners.set(channel, listener);
  },
};

export const clipboard = {
  readText(): string {
    return '';
  },
};

export const contextBridge = {
  exposeInMainWorld(): void {},
};

export const ipcRenderer = {
  on(): void {},
  send(): void {},
  invoke(): Promise<unknown> {
    return Promise.resolve(undefined);
  },
};

export default { app, Menu, nativeImage, ipcMain, clipboard, contextBridge, ipcRenderer };
