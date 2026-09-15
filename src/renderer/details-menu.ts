// The items of the popup's Details and Power views that come and go with the game and the screen:
// Install/Uninstall, Force close, Home, Customize, Remove from history — and Minimize, which Game Mode
// has no tray for. Their visibility rules live here; the popup (popups.ts) owns the stack they sit in,
// which is why it can hold them still during its fade-out (`isFrozen`).
import type { AppState, BrowseInfo, GameInfo } from '../shared/types.js';
import type { Translator } from '../shared/i18n/index.js';
import type { CarouselNav } from './controls-deps.js';
import { req } from './dom.js';
import { phaseOf, steamBusy } from './state-view.js';

export interface DetailsMenuDeps {
  getState(): AppState;
  getBrowse(): BrowseInfo | null;
  getTranslator(): Translator;
  readonly carousel: Pick<CarouselNav, 'screen'>;
  screenGame(): GameInfo | undefined;
  screenIsActionable(): boolean;
  /** The popup is fading out: its items must not rewrite themselves in view (see popups.ts). */
  isFrozen(): boolean;
}

export interface DetailsMenu {
  /** Refreshes the game-dependent Details items from the current state. */
  applyGameButtons(): void;
  /** Clears them for the idle/no-game screen. */
  clearGameButtons(): void;
  /** Whether this is a Game Mode session — "Minimize Playhook" goes then. */
  applyPowerItems(gameMode: boolean): void;
}

export function createDetailsMenu(deps: DetailsMenuDeps): DetailsMenu {
  const state = (): AppState => deps.getState();
  const t = (): Translator => deps.getTranslator();
  const screenGame = (): GameInfo | undefined => deps.screenGame();
  const screenIsActionable = (): boolean => deps.screenIsActionable();
  const menuInstallToggle = req<HTMLButtonElement>('menu-install-toggle');
  const menuKill = req<HTMLButtonElement>('menu-kill');
  const menuHome = req<HTMLButtonElement>('menu-home');
  const menuCustomize = req<HTMLButtonElement>('menu-customize');
  const menuForget = req<HTMLButtonElement>('menu-forget');
  const powerMinimize = req<HTMLButtonElement>('power-minimize');

  // ── Menu item: Install / Uninstall (game-dependent) ──────────────────────────
  // One button whose text + visibility follow the current game: "Install" when it needs installing,
  // "Uninstall" when installed & removable, hidden entirely for a plain executable (no install block).
  /**
   * Whether the Details menu currently belongs to ONE game. On the carousel it does not: the strip is a
   * browsing surface, and its More is the launcher-level menu (System + Close). Every game-specific item
   * is gated on this, so none of them can appear over a row of cards.
   */
  function onGameScreen(): boolean {
    return deps.carousel.screen() === 'detail';
  }

  function applyMenuInstallToggle(): void {
    if (deps.isFrozen()) return;
    if (!onGameScreen()) {
      menuInstallToggle.classList.add('is-hidden');
      return;
    }
    const game = screenIsActionable() ? screenGame() : undefined;
    // While an install/uninstall (card or Steam) is in flight, the Install/Uninstall item is hidden —
    // acting on it mid-operation makes no sense (Details still opens for the stats + power actions).
    const busy = phaseOf(state()) === 'busy' || steamBusy(state());
    const showInstall = !busy && game?.requiresInstall === true;
    const showUninstall = !busy && game?.canUninstall === true;
    const show = showInstall || showUninstall;
    menuInstallToggle.classList.toggle('is-hidden', !show);
    if (show) {
      menuInstallToggle.textContent = t()(
        showInstall ? 'launcher.menu.install' : 'launcher.menu.uninstall',
      );
      // Which action Yes will run — read back in the stack trigger.
      menuInstallToggle.dataset['action'] = showInstall ? 'install' : 'uninstall';
    }
  }

  // ── Menu item: Force close (running-only) ────────────────────────────────────
  // The MIRROR IMAGE of the install toggle: shown ONLY while a game is running (running is a busy phase,
  // so this is the exact opposite of the install toggle, which hides during busy). Text from JS (no
  // data-i18n) so a language change re-labels it at render time and it stays out of the i18n HTML test.
  function applyMenuKill(): void {
    if (deps.isFrozen()) return;
    // Shown only while a game is running AND a force-close isn't already in flight (during killing the
    // status reads "Force closing…" and the button would be a no-op — main guards a repeat anyway).
    const s = state();
    const running = onGameScreen() && s.kind === 'running' && s.killing !== true;
    menuKill.classList.toggle('is-hidden', !running);
    if (running) menuKill.textContent = t()('launcher.menu.forceClose');
  }

  // ── Menu item: Home (back to the history carousel) ───────────────────────────
  // The MOUSE route out of a detail screen — the gamepad/keyboard have B for it, but a mouse user had no
  // way back to the strip. Shown only on a detail screen that has a carousel behind it.
  function applyMenuHome(): void {
    if (deps.isFrozen()) return;
    const show = deps.carousel.screen() === 'detail';
    menuHome.classList.toggle('is-hidden', !show);
    if (show) menuHome.textContent = t()('launcher.menu.goBack');
  }

  // ── Menu item: Remove from history (history-only games) ──────────────────────
  // Offered ONLY for a game that is not available right now — `active` is main's word for "on the card or
  // in the PC library". Those games are rebuilt from their manifests on every insert, so removing one
  // would be a lie the next refresh undoes; what CAN be removed is the record of a game you no longer
  // have. Since the history-config feature it can share the menu with Customize (see below).
  // ── Menu item: Customize (the per-game manifest editor) ──────────────────────
  // Offered for an AVAILABLE game — `active` is main's word for "on the card or in the PC library", and
  // it is the condition under which a game.json to edit exists right now — and, since the history-config
  // feature, for a history game main has a card snapshot of (`configurable`): those are edited with no
  // card in, and the edits reach the card on its next insertion. So this and "Remove from history" now
  // SHARE the menu for a history game — they used to be mutually exclusive by construction.
  function applyMenuCustomize(): void {
    if (deps.isFrozen()) return;
    const browse = deps.getBrowse();
    const show =
      onGameScreen() && browse !== null && (browse.active || browse.configurable === true);
    menuCustomize.classList.toggle('is-hidden', !show);
    if (show) menuCustomize.textContent = t()('launcher.menu.customize');
  }

  function applyMenuForget(): void {
    if (deps.isFrozen()) return;
    const browse = deps.getBrowse();
    const show = onGameScreen() && browse !== null && !browse.active;
    menuForget.classList.toggle('is-hidden', !show);
    if (show) menuForget.textContent = t()('launcher.menu.forget');
  }

  // The power menu carries both ways out of the launcher: "Minimize Playhook" (hide to the tray) and
  // "Close Playhook" (full quit). In Game Mode the first one goes — there is no tray to hide into, so
  // hiding is a no-op there, and the quit is the honest option (mirrors how closing the window quits in
  // Game Mode).
  function applyPowerItems(gameMode: boolean): void {
    powerMinimize.classList.toggle('is-hidden', gameMode);
  }

  function applyGameButtons(): void {
    // The game-dependent Details items: the Install/Uninstall toggle and the running-only Force close.
    // Refreshed every render so they stay correct if the game state changes while Details is open (a
    // running→syncing-out self-exit must drop Force close; a ready→ready update doesn't close the popup).
    applyMenuInstallToggle();
    applyMenuKill();
    applyMenuHome();
    applyMenuCustomize();
    applyMenuForget();
  }

  function clearGameButtons(): void {
    if (deps.isFrozen()) return;
    // No game → no Install/Uninstall item and no Force close (the popup is force-closed off the ready
    // screen anyway; no-game is never `running`).
    menuInstallToggle.classList.add('is-hidden');
    menuKill.classList.add('is-hidden');
    menuCustomize.classList.add('is-hidden'); // no game on screen → no manifest to customize
    menuForget.classList.add('is-hidden'); // no game on screen → nothing to remove from the history
    applyMenuHome(); // the carousel can still be there with no game on screen (history only)
  }

  return { applyGameButtons, clearGameButtons, applyPowerItems };
}
