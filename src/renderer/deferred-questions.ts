import type { GameCollision } from '../shared/types.js';
import type { QuitAction, QuitConfirmReply } from '../shared/quit.js';

/** What the queue needs from the popup column it waits on. */
export interface DeferredQuestionsDeps {
  /** Which view the popup column shows, 'none' while it is closed. */
  popupView(): string;
  /** A full-screen surface with questions of its own is up (Customize, Settings). */
  isScreenAsking(): boolean;
  openCollision(collision: GameCollision): void;
  /** Opens main's quit question for `action`; true once it is on screen. */
  openQuit(action: QuitAction): boolean;
  replyQuit(reply: QuitConfirmReply): void;
  readonly fadeMs: number;
}

/** The questions main raises on its own, held back while the popup column is in use. */
export interface DeferredQuestions {
  askCollision(collision: GameCollision): void;
  /** main asks before `action` while jobs run; it hears at once that the question is shown or queued. */
  askQuit(action: QuitAction): void;
  /** main's quit question got its Yes: closing the column is not a dismissal then. */
  quitAnswered(): void;
  /** The column closed: reports an unanswered quit question, then raises whatever waited. */
  columnClosed(): void;
}

/**
 * Creates the queue of main's own questions: the card-vs-PC collision and the quit question asked while
 * background jobs run. Neither may wipe out a question, an error or work in progress the user is looking
 * at; each waits for the column to close and comes up after its fade.
 */
export function createDeferredQuestions(deps: DeferredQuestionsDeps): DeferredQuestions {
  let queuedCollision: GameCollision | null = null;
  let queuedQuit: QuitAction | null = null;
  let quitAsked = false;

  function after(fade: () => void): void {
    window.setTimeout(() => {
      if (deps.popupView() === 'none') fade();
    }, deps.fadeMs);
  }

  /** Raises a collision question that arrived while the column was busy, once it is free again. */
  function flushCollision(): void {
    const waiting = queuedCollision;
    if (waiting === null || deps.popupView() !== 'none' || deps.isScreenAsking()) return;
    queuedCollision = null;
    // After the fade, or the question would open into a column still fading the previous one out.
    after(() => deps.openCollision(waiting));
  }

  function flushQuit(): void {
    const waiting = queuedQuit;
    if (waiting === null || deps.popupView() !== 'none') return;
    queuedQuit = null;
    after(() => {
      quitAsked = deps.openQuit(waiting);
    });
  }

  return {
    askCollision: (collision) => {
      // One at a time, and never over something the user is in the middle of: a confirm, the Customize
      // screen's own question, the power menu. It is picked up the moment the surface clears.
      if (deps.popupView() !== 'none' || deps.isScreenAsking()) {
        queuedCollision = collision;
        return;
      }
      deps.openCollision(collision);
    },
    askQuit: (action) => {
      deps.replyQuit('shown');
      const view = deps.popupView();
      if (view === 'confirm' || view === 'busy' || view === 'error') {
        queuedQuit = action;
        return;
      }
      quitAsked = deps.openQuit(action);
    },
    quitAnswered: () => {
      quitAsked = false;
    },
    columnClosed: () => {
      if (quitAsked) {
        quitAsked = false;
        deps.replyQuit('dismissed');
      }
      flushCollision();
      flushQuit();
    },
  };
}
