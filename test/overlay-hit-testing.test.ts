// Guard for the one CSS rule a screen can be clicked THROUGH.
//
// A full-screen overlay hides the screen under it with opacity plus `pointer-events: none` on the
// section — but that is undone by any child that sets `auto`, and the cards do exactly that so the
// carousel strip (a full-width band across the bottom bar) can stay transparent to the mouse while its
// cards are not. Ungated, that `auto` reached cards under an open Customize / Add-game screen: the
// pointer turned into a hand over a game nobody could see, and clicking selected it behind the screen.
//
// Read from source, the way the IPC contract is: the rule cannot be exercised here (the suite runs in
// plain Node with no layout engine), and it is one deletion away from coming back.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(__dirname, '../src/renderer/styles.css'), 'utf8');

/** Every selector that turns hit-testing back ON for a card, with the comments above it stripped off. */
function cardSelectorsEnablingPointerEvents(): readonly string[] {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]*\.card[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /pointer-events:\s*auto/.test(body ?? ''))
    .map(([, selector]) => (selector ?? '').replace(/\s+/g, ' ').trim());
}

describe('cards cannot be clicked through an overlay', () => {
  const selectors = cardSelectorsEnablingPointerEvents();

  it('has rules that make cards hit-testable at all', () => {
    expect(selectors.length).toBeGreaterThan(0);
  });

  it('gates every one of them on an overlay state', () => {
    for (const selector of selectors) {
      const gated = selector.includes(':not([data-overlay])') || selector.includes('[data-overlay=');
      expect(gated, `ungated card rule: ${selector}`).toBe(true);
    }
  });

  it('keeps the carousel strip clickable only with no overlay open', () => {
    expect(selectors).toContain("#app[data-screen='carousel']:not([data-overlay]) .card");
  });

  it("re-enables the library's own cards for the overlay that shows them", () => {
    expect(selectors).toContain("#app[data-overlay='library'] #library .library-grid .card");
  });
});
