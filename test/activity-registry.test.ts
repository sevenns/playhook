import { describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../src/main/activity-registry';
import { sameActivity, type ActivityMap } from '../src/shared/activity';

function recorded(registry: ActivityRegistry): ActivityMap[] {
  const pushes: ActivityMap[] = [];
  registry.subscribe((activities) => pushes.push(activities));
  return pushes;
}

describe('ActivityRegistry', () => {
  it('starts empty: every game is free', () => {
    const registry = new ActivityRegistry();
    expect(registry.snapshot()).toEqual({});
    expect(registry.get('a')).toBeUndefined();
    expect(registry.has('a')).toBe(false);
  });

  it('keeps one activity per game and pushes the full snapshot on each change', () => {
    const registry = new ActivityRegistry();
    const pushes = recorded(registry);
    registry.set('a', { kind: 'steam-installing', paused: false });
    registry.set('b', { kind: 'steam-uninstalling' });
    expect(registry.get('a')).toEqual({ kind: 'steam-installing', paused: false });
    expect(registry.has('b')).toBe(true);
    expect(pushes).toEqual([
      { a: { kind: 'steam-installing', paused: false } },
      { a: { kind: 'steam-installing', paused: false }, b: { kind: 'steam-uninstalling' } },
    ]);
  });

  it('announces nothing when the value is equal to the current one', () => {
    const registry = new ActivityRegistry();
    registry.set('a', { kind: 'steam-updating', paused: true, pausedProgress: 0.5 });
    const pushes = recorded(registry);
    registry.set('a', { kind: 'steam-updating', paused: true, pausedProgress: 0.5 });
    expect(pushes).toEqual([]);
    registry.set('a', { kind: 'steam-updating', paused: true, pausedProgress: 0.6 });
    expect(pushes).toEqual([{ a: { kind: 'steam-updating', paused: true, pausedProgress: 0.6 } }]);
  });

  it('clear frees the game and leaves the others; clearing a free game announces nothing', () => {
    const registry = new ActivityRegistry();
    registry.set('a', { kind: 'installing' });
    registry.set('b', { kind: 'queued' });
    const pushes = recorded(registry);
    registry.clear('a');
    registry.clear('a');
    expect(registry.snapshot()).toEqual({ b: { kind: 'queued' } });
    expect(pushes).toEqual([{ b: { kind: 'queued' } }]);
  });

  it('a snapshot handed out earlier is not mutated by later changes', () => {
    const registry = new ActivityRegistry();
    registry.set('a', { kind: 'installing' });
    const before = registry.snapshot();
    registry.set('a', { kind: 'uninstalling' });
    registry.clear('a');
    expect(before).toEqual({ a: { kind: 'installing' } });
  });

  it('unsubscribe stops the pushes', () => {
    const registry = new ActivityRegistry();
    const pushes: ActivityMap[] = [];
    const stop = registry.subscribe((activities) => pushes.push(activities));
    stop();
    registry.set('a', { kind: 'installing' });
    expect(pushes).toEqual([]);
  });
});

describe('sameActivity', () => {
  it('compares field by field, including an absent optional field', () => {
    expect(sameActivity(undefined, undefined)).toBe(true);
    expect(sameActivity({ kind: 'installing' }, undefined)).toBe(false);
    expect(sameActivity({ kind: 'installing' }, { kind: 'installing' })).toBe(true);
    expect(sameActivity({ kind: 'installing' }, { kind: 'uninstalling' })).toBe(false);
    expect(
      sameActivity(
        { kind: 'steam-installing', paused: true },
        { kind: 'steam-installing', paused: true, pausedProgress: 0.1 },
      ),
    ).toBe(false);
  });
});
