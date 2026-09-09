// The two ways a focus index moves, as pure functions: clamped (a list, where the ends are walls) and
// wrapped (a popup stack or an expanded dropdown, where they meet). Shared by the launcher's screens so
// "does it stop or does it cycle?" is one decision per surface rather than a formula rewritten per file.

/** Steps `index` by `delta`, stopping at either end. An empty list stays at 0. */
export function clampIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

/** Steps `index` by `delta`, wrapping around both ends. An empty list stays at 0. */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
