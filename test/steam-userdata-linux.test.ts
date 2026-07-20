// Picking the Steam account whose userdata/ we write into, plus the paths under it. The refusal cases
// matter as much as the happy path: writing a shortcut into the wrong account is worse than not writing
// one, so ambiguity must never resolve to a guess.
import { describe, it, expect } from 'vitest';
import {
  gridDir,
  loginUsersPath,
  parseLoginUsers,
  pickSteamUser,
  pickUserdataDir,
  shortcutsVdfPath,
  steamId64ToId3,
  userdataDir,
  type LoginUser,
} from '../src/main/platform/steam-userdata.linux';

const STEAM_ROOT = '/home/deck/.local/share/Steam';

describe('paths', () => {
  it('builds the userdata paths Steam uses', () => {
    expect(userdataDir(STEAM_ROOT)).toBe('/home/deck/.local/share/Steam/userdata');
    expect(shortcutsVdfPath(STEAM_ROOT, 1015542901)).toBe(
      '/home/deck/.local/share/Steam/userdata/1015542901/config/shortcuts.vdf',
    );
    expect(gridDir(STEAM_ROOT, 1015542901)).toBe(
      '/home/deck/.local/share/Steam/userdata/1015542901/config/grid',
    );
    expect(loginUsersPath(STEAM_ROOT)).toBe('/home/deck/.local/share/Steam/config/loginusers.vdf');
  });
});

describe('steamId64ToId3', () => {
  it('matches the real Deck pair', () => {
    // Read off a live Deck: this SteamID64's userdata directory really is named 1015542901.
    expect(steamId64ToId3('76561198975808629')).toBe(1015542901);
  });

  it('rejects a non-numeric id', () => {
    expect(steamId64ToId3('nope')).toBeNull();
    expect(steamId64ToId3('')).toBeNull();
  });
});

const SINGLE_USER = `"users"
{
	"76561198975808629"
	{
		"AccountName"		"deckuser"
		"PersonaName"		"Deck User"
		"RememberPassword"		"1"
		"MostRecent"		"1"
		"Timestamp"		"1752969600"
	}
}
`;

const TWO_USERS = `"users"
{
	"76561198975808629"
	{
		"AccountName"		"first"
		"PersonaName"		"First"
		"MostRecent"		"0"
		"Timestamp"		"1000"
	}
	"76561198000000001"
	{
		"AccountName"		"second"
		"PersonaName"		"Second"
		"MostRecent"		"1"
		"Timestamp"		"2000"
	}
}
`;

describe('parseLoginUsers', () => {
  it('parses the block structure, not just flat keys', () => {
    const users = parseLoginUsers(SINGLE_USER);
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual<LoginUser>({
      steamId64: '76561198975808629',
      accountName: 'deckuser',
      personaName: 'Deck User',
      mostRecent: true,
      timestamp: 1752969600,
    });
  });

  it('parses several accounts', () => {
    const users = parseLoginUsers(TWO_USERS);
    expect(users.map((user) => user.accountName)).toEqual(['first', 'second']);
    expect(users.filter((user) => user.mostRecent).map((user) => user.accountName)).toEqual([
      'second',
    ]);
  });

  it('skips comments and tolerates a truncated file', () => {
    const users = parseLoginUsers(`// a comment\n${SINGLE_USER.slice(0, SINGLE_USER.length - 3)}`);
    expect(users.map((user) => user.accountName)).toEqual(['deckuser']);
  });

  it('yields nothing for content that is not a users file', () => {
    expect(parseLoginUsers('')).toEqual([]);
    expect(parseLoginUsers('garbage without quotes or braces')).toEqual([]);
  });
});

describe('pickSteamUser', () => {
  const user = (id64: string, mostRecent: boolean, timestamp: number): LoginUser => ({
    steamId64: id64,
    accountName: 'a',
    personaName: 'b',
    mostRecent,
    timestamp,
  });

  it('picks the only account', () => {
    expect(pickSteamUser(parseLoginUsers(SINGLE_USER))).toEqual({ ok: true, steamId3: 1015542901 });
  });

  it('picks MostRecent when several accounts exist', () => {
    const result = pickSteamUser(parseLoginUsers(TWO_USERS));
    expect(result).toEqual({ ok: true, steamId3: steamId64ToId3('76561198000000001') });
  });

  it('falls back to the newest Timestamp when MostRecent does not decide', () => {
    const users = [user('76561198975808629', false, 100), user('76561198000000001', false, 200)];
    expect(pickSteamUser(users)).toEqual({
      ok: true,
      steamId3: steamId64ToId3('76561198000000001'),
    });
  });

  it('refuses when two accounts are equally recent', () => {
    const users = [user('76561198975808629', true, 100), user('76561198000000001', true, 100)];
    const result = pickSteamUser(users);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty list rather than guessing', () => {
    expect(pickSteamUser([]).ok).toBe(false);
  });
});

describe('pickUserdataDir', () => {
  it('picks the sole real account directory', () => {
    expect(pickUserdataDir(['0', 'anonymous', '1015542901'])).toEqual({
      ok: true,
      steamId3: 1015542901,
    });
  });

  it('refuses when several accounts have a directory', () => {
    expect(pickUserdataDir(['0', '1015542901', '42']).ok).toBe(false);
  });

  it('refuses when there is nothing but service entries', () => {
    expect(pickUserdataDir(['0', 'anonymous']).ok).toBe(false);
    expect(pickUserdataDir([]).ok).toBe(false);
  });
});
