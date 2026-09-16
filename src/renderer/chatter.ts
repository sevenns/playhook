// "Chatter": a rotating funny suffix for long busy phases (install / Proton config).
//
// The base status ("Installing..." / "Configuring Proton...") shows alone for the first MINUTE; after that
// a random funny suffix is APPENDED and swapped every 20s, so a long silent install/provision doesn't feel
// stuck. Renderer-owned (pure presentation) — main only sets the base state. This module owns the timers
// and the current suffix; app.ts composes the line (the base status belongs to what is ON SCREEN, which
// only app.ts knows).
import type { AppState } from '../shared/types.js';
import type { MessageKey } from '../shared/i18n/index.js';

const CHATTER_DELAY_MS = 60_000; // base-only for the first minute
const CHATTER_ROTATE_MS = 20_000; // then swap the funny suffix every 20 seconds
const INSTALL_SUFFIX_KEYS: readonly MessageKey[] = [
  'launcher.installChatter1',
  'launcher.installChatter2',
  'launcher.installChatter3',
  'launcher.installChatter4',
  'launcher.installChatter5',
  'launcher.installChatter6',
  'launcher.installChatter7',
  'launcher.installChatter8',
  'launcher.installChatter9',
  'launcher.installChatter10',
];
// Reuse the Proton funny lines as suffixes appended to "Configuring Proton..." (protonConfig1 is the base).
const PROTON_SUFFIX_KEYS: readonly MessageKey[] = [
  'launcher.protonConfig2',
  'launcher.protonConfig3',
  'launcher.protonConfig4',
  'launcher.protonConfig5',
  'launcher.protonConfig6',
  'launcher.protonConfig7',
  'launcher.protonConfig8',
  'launcher.protonConfig9',
  'launcher.protonConfig10',
  'launcher.protonConfig11',
  'launcher.protonConfig12',
];

type ChatterKind = 'installing' | 'configuringProton';

export interface ChatterDeps {
  /** A new suffix was picked — the status line has to be redrawn. */
  onRotate(): void;
}

export interface Chatter {
  /** (Re)starts / stops the timers as the state enters / leaves a long busy phase. */
  sync(state: AppState): void;
  /** The suffix to append for `state`, or null while the base label shows alone (or for another phase). */
  suffixFor(state: AppState): MessageKey | null;
}

function chatterPool(kind: ChatterKind): readonly MessageKey[] {
  return kind === 'installing' ? INSTALL_SUFFIX_KEYS : PROTON_SUFFIX_KEYS;
}

export function createChatter(deps: ChatterDeps): Chatter {
  let kind: ChatterKind | null = null;
  let suffix: MessageKey | null = null;
  let delayTimer = 0;
  let rotateTimer = 0;

  function stopTimers(): void {
    if (delayTimer !== 0) {
      window.clearTimeout(delayTimer);
      delayTimer = 0;
    }
    if (rotateTimer !== 0) {
      window.clearInterval(rotateTimer);
      rotateTimer = 0;
    }
  }

  function rotate(of: ChatterKind): void {
    const pool = chatterPool(of);
    suffix = pool[Math.floor(Math.random() * pool.length)] ?? null;
    deps.onRotate();
  }

  // First suffix appears at the first tick (~1 min); base-only before that. A phase change resets it
  // (each phase gets its minute).
  function sync(state: AppState): void {
    const next: ChatterKind | null =
      state.kind === 'installing' || state.kind === 'configuringProton' ? state.kind : null;
    if (next === kind) return; // same phase (or same non-phase) — keep the running timers
    stopTimers();
    kind = next;
    suffix = null; // base only for the first minute
    if (next !== null) {
      delayTimer = window.setTimeout(() => {
        delayTimer = 0;
        rotate(next); // first funny suffix at 1 minute
        rotateTimer = window.setInterval(() => rotate(next), CHATTER_ROTATE_MS); // then every 20s
      }, CHATTER_DELAY_MS);
    }
  }

  return {
    sync,
    suffixFor: (state) => (suffix !== null && state.kind === kind ? suffix : null),
  };
}
