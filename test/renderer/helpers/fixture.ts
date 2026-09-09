import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/renderer/index.html',
);

const BODY = /<body>([\s\S]*)<\/body>/;
const MODULE_SCRIPT = /<script type="module"[\s\S]*?<\/script>/g;

function readBody(): string {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const body = BODY.exec(html);
  if (body === null) throw new Error('index.html has no <body>');
  return (body[1] ?? '').replace(MODULE_SCRIPT, '');
}

const bodyHtml = readBody();

/**
 * Installs the real renderer markup so `req()` finds every id the controllers ask for. `mouse-asleep`
 * lives on `<html>` in index.html — outside the body — and is the state every mousemove branch reads,
 * so it is restored here too. Call it per test: the controllers never remove their listeners, so a
 * fixture shared across tests collects one live instance per test on the same nodes.
 */
export function loadFixture(): void {
  document.body.innerHTML = bodyHtml;
  document.documentElement.className = 'mouse-asleep';
}

/** Drops `mouse-asleep`, as controls.ts does on the first real move — every hover branch is behind it. */
export function wakeMouse(): void {
  document.documentElement.classList.remove('mouse-asleep');
}

/**
 * A mouse move onto `target`. The hover guard ignores a move that lands within 6px of where it was armed
 * (the UI arriving under a still cursor), so the default coordinates sit well clear of that.
 */
export function hoverOver(target: Element, x = 400, y = 300): void {
  wakeMouse();
  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
}
