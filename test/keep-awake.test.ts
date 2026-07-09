// KeepAwakeService unit tests. The service is electron-free on import (powerSaveBlocker is injected via
// deps), so it runs in plain Node with a fake blocker — we assert idempotent start/stop and that dispose
// is a safe no-op when nothing is held (the double quit()+before-quit call).
import { describe, expect, it, vi } from 'vitest';
import { createKeepAwakeService, type KeepAwakeDeps } from '../src/main/keep-awake';

// A fake powerSaveBlocker: hands out incrementing ids and tracks which are active.
function makeDeps(): { deps: KeepAwakeDeps; active: Set<number> } {
  let nextId = 1;
  const active = new Set<number>();
  const deps: KeepAwakeDeps = {
    start: vi.fn(() => {
      const id = nextId++;
      active.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      active.delete(id);
    }),
    isStarted: vi.fn((id: number) => active.has(id)),
  };
  return { deps, active };
}

describe('KeepAwakeService', () => {
  it('setActive(true) starts the blocker once; a second call is idempotent', () => {
    const { deps, active } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.setActive(true);
    svc.setActive(true);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(1);
  });

  it('setActive(false) stops the blocker; a second call is a no-op', () => {
    const { deps, active } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.setActive(true);
    svc.setActive(false);
    svc.setActive(false);
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

  it('setActive(false) with nothing active never calls stop', () => {
    const { deps } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.setActive(false);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('re-activates after a stop (start called again)', () => {
    const { deps, active } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.setActive(true);
    svc.setActive(false);
    svc.setActive(true);
    expect(deps.start).toHaveBeenCalledTimes(2);
    expect(active.size).toBe(1);
  });

  it('dispose() stops an active blocker', () => {
    const { deps, active } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.setActive(true);
    svc.dispose();
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

  it('dispose() with nothing held is a no-op (safe double quit()+before-quit)', () => {
    const { deps } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.dispose();
    svc.dispose();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('dispose() after an active blocker is safe to call twice', () => {
    const { deps } = makeDeps();
    const svc = createKeepAwakeService(deps);
    svc.setActive(true);
    svc.dispose();
    svc.dispose();
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });
});
