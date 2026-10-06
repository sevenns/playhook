/**
 * Update state for the Settings screen (discriminated union). The UpdaterService owns the current
 * snapshot, returns it on request and pushes it on every change. Maps 1:1 onto electron-updater
 * events (see updater.ts). `unsupported` is set immediately when this build cannot self-update at all —
 * in dev / non-packaged, and on macOS (unsigned bundle, see UpdateUnsupportedReason) — and the settings
 * screen then shows the version plus an explanation instead of the update controls.
 */
export type UpdateStatus =
  | { readonly kind: 'idle' } // not checked yet
  | { readonly kind: 'checking' } // a check is in flight
  | { readonly kind: 'not-available'; readonly checkedAt: number } // up to date
  | { readonly kind: 'available'; readonly version: string } // newer version → "Update" button
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'installing'; readonly version: string }
  | { readonly kind: 'downloaded'; readonly version: string } // ready → "Restart & install"
  | { readonly kind: 'error'; readonly message: string } // → "Retry"
  | { readonly kind: 'unsupported'; readonly reason: UpdateUnsupportedReason };

/**
 * WHY a build cannot self-update — the two cases need different words, and the settings screen shows
 * different controls for them:
 * - `not-packaged` — a dev run. Temporary and about the build, not the platform: the auto-update MODE is
 *   still worth showing and persisting there, because the installed build will honour it.
 * - `platform` — macOS. Permanent for this distribution: Squirrel.Mac only updates a code-signed bundle
 *   and the mac build is unsigned (no Apple Developer ID), so updating means downloading the new dmg by
 *   hand. A mode selector would be a control that can never do anything, so the screen omits it.
 */
export type UpdateUnsupportedReason = 'not-packaged' | 'platform';
