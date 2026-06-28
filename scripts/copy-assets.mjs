// Copy static renderer assets (html/css/fonts) into dist next to the compiled JS.
// Runs as part of `npm run build` after tsc.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRenderer = resolve(root, 'src/renderer');
const outDist = resolve(root, 'dist');
const outRenderer = resolve(outDist, 'renderer');

const files = ['index.html', 'styles.css'];
const dirs = ['fonts'];

await mkdir(outRenderer, { recursive: true });
for (const name of files) {
  await cp(resolve(srcRenderer, name), resolve(outRenderer, name));
}
for (const name of dirs) {
  await cp(resolve(srcRenderer, name), resolve(outRenderer, name), { recursive: true });
}

// App icons: copied into dist so they ship inside the asar and are usable at runtime.
// icon.ico — main app icon (BrowserWindow; also referenced by electron-builder for exe/installer).
// icon-tray.ico — smaller/simpler icon for the tray, so it doesn't turn to mush at tray size.
const icons = ['icon.ico', 'icon-tray.ico'];
for (const name of icons) {
  await cp(resolve(root, name), resolve(outDist, name));
}

console.log(`Copied ${files.length} file(s), ${dirs.length} dir(s) and ${icons.length} icon(s) to dist`);
