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

// App icon: copied into dist so it ships inside the asar and is usable at runtime
// (BrowserWindow + Tray). electron-builder also references icon.ico for the exe/installer.
await cp(resolve(root, 'icon.ico'), resolve(outDist, 'icon.ico'));

console.log(`Copied ${files.length} file(s), ${dirs.length} dir(s) and icon.ico to dist`);
