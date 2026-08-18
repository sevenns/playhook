// The launcher's own cards, sitting at the tail of the history carousel: Notifications, Settings and
// System. They belong to the RENDERER, not to main's library — main owns games (manifests, history,
// eviction, ordering) while these three are pure UI, and pushing them through LibraryEntry would make
// the library index know about buttons. carousel.ts splices them in after the games.
//
// No DOM here on purpose: the list is the contract with the mockup, and a test in a plain Node
// environment has to be able to read it. The icons live in system-card-icons.ts.
import type { MessageKey } from '../shared/i18n/index.js';

/** Which launcher card this is (also the value carousel.ts reports to app.ts on activation). */
export type SystemCardId = 'notifications' | 'settings' | 'power';

export interface SystemCard {
  readonly id: SystemCardId;
  /**
   * The caption shown in #title while the card is selected — the same place a game's name goes (that is
   * where the mockup puts it). Null for the power card: the mockup shows no caption for it at all.
   */
  readonly titleKey: MessageKey | null;
  /** The card node's aria-label — the only name the power card has, since it shows no caption. */
  readonly ariaKey: MessageKey;
}

/** The three cards, in the mockup's order (they always sit after the games, never between them). */
export const SYSTEM_CARDS: readonly SystemCard[] = [
  {
    id: 'notifications',
    titleKey: 'launcher.card.notifications',
    ariaKey: 'launcher.card.notifications',
  },
  { id: 'settings', titleKey: 'launcher.card.settings', ariaKey: 'launcher.card.settings' },
  { id: 'power', titleKey: null, ariaKey: 'launcher.card.system' },
] as const;
