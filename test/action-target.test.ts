import { describe, expect, it } from 'vitest';
import { resolveActionTarget, type ActionTargetInput } from '../src/main/action-target';

function input(patch: Partial<ActionTargetInput> = {}): ActionTargetInput {
  return {
    action: 'launch',
    id: 'd',
    selectedId: 'd',
    sessionBusy: false,
    sessionGameId: null,
    hasActivity: false,
    sourceAvailable: true,
    reloadInFlight: false,
    ...patch,
  };
}

describe('resolveActionTarget', () => {
  it('session free, the selected game: launch or install as before, uninstall directly', () => {
    expect(resolveActionTarget(input())).toBe('launch-or-install-selected');
    expect(resolveActionTarget(input({ action: 'uninstall' }))).toBe('uninstall-only');
  });

  it('session free, another game: select it first, then act', () => {
    expect(resolveActionTarget(input({ selectedId: 'c' }))).toBe('select-then-act');
    expect(resolveActionTarget(input({ action: 'uninstall', selectedId: 'c' }))).toBe(
      'select-then-act',
    );
    expect(resolveActionTarget(input({ selectedId: null }))).toBe('select-then-act');
  });

  it("session busy, the session's own game: Play resumes, Uninstall is refused", () => {
    const busy = { sessionBusy: true, sessionGameId: 'd' };
    expect(resolveActionTarget(input(busy))).toBe('resume-session');
    expect(resolveActionTarget(input({ ...busy, action: 'uninstall' }))).toBe('refuse');
  });

  it('session busy, another game: install or remove only, never a second launch', () => {
    const busy = { sessionBusy: true, sessionGameId: 'c', selectedId: 'c' };
    expect(resolveActionTarget(input(busy))).toBe('install-only');
    expect(resolveActionTarget(input({ ...busy, action: 'uninstall' }))).toBe('uninstall-only');
  });

  it('refuses a busy target, a game whose card is gone, and anything during a reload — in any session', () => {
    for (const session of [{}, { sessionBusy: true, sessionGameId: 'c' }]) {
      expect(resolveActionTarget(input({ ...session, hasActivity: true }))).toBe('refuse');
      expect(resolveActionTarget(input({ ...session, sourceAvailable: false }))).toBe('refuse');
      expect(resolveActionTarget(input({ ...session, reloadInFlight: true }))).toBe('refuse');
      expect(
        resolveActionTarget(input({ ...session, action: 'uninstall', hasActivity: true })),
      ).toBe('refuse');
    }
  });
});
