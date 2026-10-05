/**
 * A background operation bound to one game. Any number of games can carry one at a time, independently of
 * the single game session AppState describes. A game absent from the ActivityMap is free.
 */
export type GameActivity =
  | { readonly kind: 'queued' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'configuringProton' }
  | { readonly kind: 'uninstalling' }
  | { readonly kind: 'steam-installing'; readonly paused: boolean; readonly pausedProgress?: number }
  | { readonly kind: 'steam-updating'; readonly paused: boolean; readonly pausedProgress?: number }
  | { readonly kind: 'steam-uninstalling' };

/** Every game's activity, keyed by game id. */
export type ActivityMap = Readonly<Record<string, GameActivity>>;

/** The activity as a plain field bag, for the field-by-field comparison below. */
function fieldsOf(activity: GameActivity): Readonly<Record<string, unknown>> {
  return activity;
}

/** Whether two activities say the same thing field by field, so a repeated poll is not reported as a change. */
export function sameActivity(a: GameActivity | undefined, b: GameActivity | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = fieldsOf(a);
  const right = fieldsOf(b);
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}
