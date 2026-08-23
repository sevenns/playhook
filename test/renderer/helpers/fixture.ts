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
 * so it is restored here too.
 */
export function loadFixture(): void {
  document.body.innerHTML = bodyHtml;
  document.documentElement.className = 'mouse-asleep';
}
