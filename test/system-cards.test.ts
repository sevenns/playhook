// The launcher cards are a contract with the mockup: which three they are, and in what order they sit at
// the tail of the carousel. Nothing else in the renderer states that — carousel.ts just splices the list
// in — so a reordering (or a fourth card slipped in) would only ever be caught by eye on a Deck.
import { describe, expect, it } from 'vitest';
import { SYSTEM_CARDS } from '../src/renderer/system-cards';

describe('SYSTEM_CARDS', () => {
  it('holds exactly the four launcher cards, in the mockup order', () => {
    expect(SYSTEM_CARDS.map((card) => card.id)).toEqual([
      'library',
      'notifications',
      'settings',
      'power',
    ]);
  });

  it('names all but the power card in the title line', () => {
    expect(SYSTEM_CARDS.map((card) => card.titleKey)).toEqual([
      'launcher.card.library',
      'launcher.card.notifications',
      'launcher.card.settings',
      // The mockup shows no caption for it — app.ts writes an empty title line rather than a name.
      null,
    ]);
  });

  it('gives every card an aria-label key (the power card has nothing else to name it)', () => {
    for (const card of SYSTEM_CARDS) {
      expect(card.ariaKey.length, `${card.id} must carry an aria key`).toBeGreaterThan(0);
    }
  });
});
