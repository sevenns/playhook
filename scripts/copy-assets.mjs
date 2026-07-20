// Copy static renderer assets (html/css/fonts) into dist next to the compiled JS.
// Runs as part of `npm run build` after tsc.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRenderer = resolve(root, 'src/renderer');
const outDist = resolve(root, 'dist');
const outRenderer = resolve(outDist, 'renderer');

// settings.js / configure.js are NOT here — esbuild emits them straight into dist/renderer (see
// build:settings / build:configure).
const files = ['index.html', 'styles.css', 'settings.html', 'settings.css', 'configure.html', 'configure.css'];
const dirs = ['fonts'];

await mkdir(outRenderer, { recursive: true });
for (const name of files) {
  await cp(resolve(srcRenderer, name), resolve(outRenderer, name));
}
for (const name of dirs) {
  await cp(resolve(srcRenderer, name), resolve(outRenderer, name), { recursive: true });
}

// App icons: copied from assets/ into dist so they ship inside the asar and are usable at runtime.
// icon.ico — main app icon (BrowserWindow, tray on Windows; also referenced by electron-builder for
//   exe/installer).
// icon.png — app icon read by main and handed to the settings window's custom title bar as a data URL
//   (its CSP allows img-src data: only); the Linux BrowserWindow/AppImage icon; the tray icon on Linux
//   (a .ico yields an empty nativeImage there); and the Steam shortcut's tile icon + grid logo.
// There are no separate icon-tray.* files any more — the tray uses these same two.
const icons = ['icon.ico', 'icon.png'];
for (const name of icons) {
  await cp(resolve(root, 'assets', name), resolve(outDist, name));
}

// Bundled default UI sounds: used by main when a game.json omits a sound slot. Shipped inside the
// asar (plain fs reads work through Electron's asar shim) and read at runtime from dist/audio.
await cp(resolve(root, 'audio'), resolve(outDist, 'audio'), { recursive: true });

// Fallback hero wallpaper: used as the background when a game has no heroImage and on the idle
// "Insert a game card" screen. Main reads it and hands it to the renderer as a data URL. JPG, so the
// data-URI MIME in asset-reader.ts must match — keep the extension in sync with that constant.
await cp(resolve(root, 'assets/playhook-wallpaper.jpg'), resolve(outDist, 'wallpaper.jpg'));

// Steam library artwork for the non-Steam shortcut (Game Mode tile). Copied out to the user's
// `userdata/<id>/config/grid/` when the shortcut is added — see steam-artwork.ts for the naming.
await cp(resolve(root, 'assets/steam'), resolve(outDist, 'steam'), { recursive: true });

console.log(
  `Copied ${files.length} file(s), ${dirs.length} dir(s), ${icons.length} icon(s), default audio, wallpaper and Steam artwork to dist`,
);
