// Minimal `electron` stub for the vitest node run (audit C1/M-4). The main modules under test import
// `electron` transitively (e.g. logger.ts → app.getPath), but there is no electron runtime in plain
// Node. vitest aliases the bare `electron` specifier to this file (see vitest.config.ts), so those
// imports resolve to inert no-ops. It exposes only what the tested import graph touches; extend as
// the test surface grows.
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

export default { app, Menu, contextBridge, ipcRenderer };
