// SteamOS Game Mode (gamescope) detection. In Game Mode there is no tray, no window focus/always-on-top
// control and exactly one window — so the launcher's "hide to tray" model collapses into "always show the
// empty/error screen", and closing the window means quitting the app (Steam ends a non-Steam game that
// way). Every hide/show decision that must differ under gamescope funnels through isGamescopeSession()
// (see the port plan Р8), so the branching lives in one place instead of being smeared across call sites.
//
// Pure and env-only (no electron), so it is unit-testable and safe to import anywhere.

/**
 * Whether the app is running inside a SteamOS Game Mode (gamescope) session. Primary signal: Steam's own
 * `SteamOS=1` + `SteamGamepadUI=1` env pair (set for processes launched from the Game Mode UI). Fallback:
 * the compositor advertises itself via `XDG_CURRENT_DESKTOP=gamescope`. Reads the live environment by
 * default; an explicit `env` is accepted for tests.
 */
export function isGamescopeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['SteamOS'] === '1' && env['SteamGamepadUI'] === '1') return true;
  return (env['XDG_CURRENT_DESKTOP'] ?? '').toLowerCase() === 'gamescope';
}
