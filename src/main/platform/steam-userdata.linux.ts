// Locating the right Steam user's `userdata/<steamId3>/` — the directory that owns `config/shortcuts.vdf`
// and `config/grid/`. Pure and electron-free (unit-tested in test/steam-userdata-linux.test.ts): path
// building plus a real block parser for the TEXT vdf `config/loginusers.vdf`.
//
// Why a parser and not the existing regex: `steamLibraryDirs` (steam.ts) matches one flat `"path"` key and
// knows nothing about nesting, while loginusers.vdf is "SteamID64 block → fields". Getting the WRONG user
// here writes the shortcut into someone else's account, so the choice is either unambiguous or refused —
// never guessed.
//
// `registry.vdf` → `Steam.ActiveUser` is deliberately NOT used: Steam zeroes it on exit, and "Steam is
// closed" is a perfectly normal moment for us to run.
import path from 'node:path';

/** One entry of `config/loginusers.vdf`. */
export interface LoginUser {
  /** The block key — a 17-digit SteamID64. */
  readonly steamId64: string;
  readonly accountName: string;
  readonly personaName: string;
  /** `"MostRecent" "1"` — the account the Steam client last logged in as. */
  readonly mostRecent: boolean;
  /** `"Timestamp"` as a number (0 when absent/unparsable) — the tie-breaker when MostRecent doesn't decide. */
  readonly timestamp: number;
}

export type SteamUserResult =
  | { readonly ok: true; readonly steamId3: number }
  | { readonly ok: false; readonly message: string };

// Always POSIX-join: these are Linux paths, so they must use `/` regardless of the OS the TESTS run on
// (a win32 `path.join` emits backslashes and fails the Windows CI job — same rule as umu.ts).
export function userdataDir(steamRoot: string): string {
  return path.posix.join(steamRoot, 'userdata');
}

export function shortcutsVdfPath(steamRoot: string, steamId3: number): string {
  return path.posix.join(userdataDir(steamRoot), String(steamId3), 'config', 'shortcuts.vdf');
}

export function gridDir(steamRoot: string, steamId3: number): string {
  return path.posix.join(userdataDir(steamRoot), String(steamId3), 'config', 'grid');
}

export function loginUsersPath(steamRoot: string): string {
  return path.posix.join(steamRoot, 'config', 'loginusers.vdf');
}

/** The account-scoped part of a SteamID64 — the `userdata/` directory name. */
export function steamId64ToId3(steamId64: string): number | null {
  if (!/^\d{6,20}$/.test(steamId64)) return null;
  try {
    return Number(BigInt(steamId64) & 0xffffffffn);
  } catch {
    return null;
  }
}

// ── Text VDF block parsing ──────────────────────────────────────────────────
// A minimal tokenizer over `"key" "value"` / `"key" { … }`, which is all Valve's text vdf is. Line
// comments (`//`) are skipped; unterminated input just ends the token stream (a truncated file yields the
// blocks it did contain rather than throwing).

type TextVdfNode = string | TextVdfBlock;
interface TextVdfBlock {
  readonly [key: string]: TextVdfNode;
}

interface Token {
  readonly kind: 'string' | 'open' | 'close';
  readonly value: string;
}

function tokenize(content: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === undefined) break;
    if (ch === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i);
      if (eol === -1) break;
      i = eol + 1;
      continue;
    }
    if (ch === '{' || ch === '}') {
      tokens.push({ kind: ch === '{' ? 'open' : 'close', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < content.length && content[j] !== '"') {
        if (content[j] === '\\' && j + 1 < content.length) {
          value += content[j + 1];
          j += 2;
          continue;
        }
        value += content[j];
        j += 1;
      }
      if (j >= content.length) break; // unterminated string → stop, keep what we have
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    i += 1; // whitespace / stray characters
  }
  return tokens;
}

/** Parses a token run into a block, starting just after its `{`. Returns the block and the next index. */
function parseBlock(
  tokens: readonly Token[],
  start: number,
): { readonly block: TextVdfBlock; readonly next: number } {
  const block: Record<string, TextVdfNode> = {};
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind === 'close') return { block, next: i + 1 };
    if (token.kind !== 'string') {
      i += 1;
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined) return { block, next: i + 1 };
    if (next.kind === 'open') {
      const nested = parseBlock(tokens, i + 2);
      block[token.value] = nested.block;
      i = nested.next;
      continue;
    }
    if (next.kind === 'string') {
      block[token.value] = next.value;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { block, next: i };
}

function asString(node: TextVdfNode | undefined): string {
  return typeof node === 'string' ? node : '';
}

/**
 * Parses `config/loginusers.vdf` into its accounts. A file we can't make sense of yields an empty list
 * (the caller then falls back to inspecting `userdata/` itself) rather than a throw.
 */
export function parseLoginUsers(content: string): readonly LoginUser[] {
  const tokens = tokenize(content);
  // Root shape: `"users" { "<id64>" { … } }`. Wrap it in a synthetic block so the same parser applies.
  const root = parseBlock([...tokens, { kind: 'close', value: '}' }], 0).block;
  const usersNode = root['users'];
  const container = typeof usersNode === 'object' ? usersNode : root;
  const users: LoginUser[] = [];
  for (const [steamId64, node] of Object.entries(container)) {
    if (typeof node !== 'object') continue;
    if (!/^\d{6,20}$/.test(steamId64)) continue;
    const timestamp = Number.parseInt(asString(node['Timestamp']), 10);
    users.push({
      steamId64,
      accountName: asString(node['AccountName']),
      personaName: asString(node['PersonaName']),
      mostRecent: asString(node['MostRecent']) === '1',
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    });
  }
  return users;
}

/**
 * Picks the account to write the shortcut for: the single `MostRecent "1"`, else the newest `Timestamp`,
 * else — when neither decides — a refusal. Writing a shortcut into the wrong account is worse than not
 * writing one at all, so ambiguity is never resolved by guessing.
 */
export function pickSteamUser(users: readonly LoginUser[]): SteamUserResult {
  if (users.length === 0) return { ok: false, message: 'no Steam accounts in loginusers.vdf' };
  if (users.length === 1) {
    const only = users[0];
    if (only === undefined) return { ok: false, message: 'no Steam accounts in loginusers.vdf' };
    return toResult(only);
  }

  const mostRecent = users.filter((user) => user.mostRecent);
  if (mostRecent.length === 1) {
    const single = mostRecent[0];
    if (single !== undefined) return toResult(single);
  }

  const candidates = mostRecent.length > 1 ? mostRecent : users;
  const newest = candidates.reduce<LoginUser | null>(
    (best, user) => (best === null || user.timestamp > best.timestamp ? user : best),
    null,
  );
  if (newest === null || newest.timestamp === 0) {
    return { ok: false, message: 'cannot tell which Steam account is active' };
  }
  // A tie on the newest timestamp is still ambiguous — refuse rather than pick by iteration order.
  if (candidates.filter((user) => user.timestamp === newest.timestamp).length > 1) {
    return { ok: false, message: 'cannot tell which Steam account is active' };
  }
  return toResult(newest);
}

function toResult(user: LoginUser): SteamUserResult {
  const steamId3 = steamId64ToId3(user.steamId64);
  if (steamId3 === null) return { ok: false, message: `invalid SteamID64 "${user.steamId64}"` };
  return { ok: true, steamId3 };
}

/**
 * Fallback when `loginusers.vdf` is missing: the sole real account directory under `userdata/`. `0` and
 * `anonymous` are Steam's own service entries and never own a user's shortcuts.
 */
export function pickUserdataDir(entries: readonly string[]): SteamUserResult {
  const candidates = entries.filter((entry) => /^\d+$/.test(entry) && entry !== '0');
  if (candidates.length === 0) return { ok: false, message: 'no Steam user directory found' };
  if (candidates.length > 1)
    return { ok: false, message: 'several Steam users found, cannot tell which is active' };
  const only = candidates[0];
  if (only === undefined) return { ok: false, message: 'no Steam user directory found' };
  const steamId3 = Number.parseInt(only, 10);
  return Number.isNaN(steamId3)
    ? { ok: false, message: 'no Steam user directory found' }
    : { ok: true, steamId3 };
}
