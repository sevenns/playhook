import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuitGate, quitConfirmAckMs, quitGraceMs, withGrace } from '../src/main/quit-gate';
import type { QuitAction } from '../src/shared/quit';

interface Fixture {
  readonly gate: QuitGate;
  readonly log: string[];
  jobs: number;
  nativeAnswer: boolean;
}

function build(): Fixture {
  const log: string[] = [];
  const state = { jobs: 0, nativeAnswer: false };
  const gate = new QuitGate({
    activeJobs: () => state.jobs,
    showAndFocus: () => log.push('show'),
    askInWindow: (action: QuitAction) => log.push(`ask:${action}`),
    askNatively: (action: QuitAction, jobs: number) => {
      log.push(`native:${action}:${jobs}`);
      return Promise.resolve(state.nativeAnswer);
    },
    ackTimeoutMs: 2000,
  });
  return {
    gate,
    log,
    get jobs() {
      return state.jobs;
    },
    set jobs(value: number) {
      state.jobs = value;
    },
    get nativeAnswer() {
      return state.nativeAnswer;
    },
    set nativeAnswer(value: boolean) {
      state.nativeAnswer = value;
    },
  };
}

let fixture: Fixture;

beforeEach(() => {
  vi.useFakeTimers();
  fixture = build();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QuitGate', () => {
  it('leaves at once when nothing is running', () => {
    const run = vi.fn();
    expect(fixture.gate.request('quit', false, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fixture.log).toEqual([]);
  });

  it('does not leave unconfirmed while jobs run: it brings the window up and asks there', () => {
    fixture.jobs = 2;
    const run = vi.fn();
    expect(fixture.gate.request('shutdown', false, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(fixture.log).toEqual(['show', 'ask:shutdown']);
  });

  it('leaves when the request carries the confirmation', () => {
    fixture.jobs = 2;
    const run = vi.fn();
    expect(fixture.gate.request('quit', true, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a second request while the question is up does not ask twice', () => {
    fixture.jobs = 1;
    fixture.gate.request('quit', false, vi.fn());
    fixture.gate.request('quit', false, vi.fn());
    expect(fixture.log.filter((entry) => entry.startsWith('ask:'))).toHaveLength(1);
  });

  it('a window that never confirms the question gets the native dialog after the timeout', async () => {
    fixture.jobs = 3;
    fixture.nativeAnswer = true;
    const run = vi.fn();
    fixture.gate.request('quit', false, run);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fixture.log).not.toContain('native:quit:3');
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.log).toContain('native:quit:3');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a native No keeps the launcher running and lets the next request ask again', async () => {
    fixture.jobs = 1;
    const run = vi.fn();
    fixture.gate.request('quit', false, run);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();
    fixture.gate.request('quit', false, run);
    expect(fixture.log.filter((entry) => entry.startsWith('ask:'))).toHaveLength(2);
  });

  it('a window that confirms it is asking gets no native dialog', async () => {
    fixture.jobs = 1;
    fixture.gate.request('quit', false, vi.fn());
    fixture.gate.reply('shown');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.log.some((entry) => entry.startsWith('native:'))).toBe(false);
  });

  it('a dismissed question is over: the next request asks again', () => {
    fixture.jobs = 1;
    fixture.gate.request('quit', false, vi.fn());
    fixture.gate.reply('shown');
    fixture.gate.reply('dismissed');
    fixture.gate.request('reboot', false, vi.fn());
    expect(fixture.log).toEqual(['show', 'ask:quit', 'show', 'ask:reboot']);
  });
});

describe('withGrace', () => {
  it('waits for the cleanup, but never longer than the grace', async () => {
    let finished = false;
    const done = withGrace(new Promise<void>(() => undefined), 3000).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(finished).toBe(true);
  });

  it('returns as soon as the cleanup is done', async () => {
    await expect(withGrace(Promise.resolve(), 3000)).resolves.toBeUndefined();
  });
});

describe('quit timings from env', () => {
  it('reads PLAYHOOK_QUIT_CONFIRM_ACK_MS and PLAYHOOK_QUIT_GRACE_MS with their defaults', () => {
    expect(quitConfirmAckMs({})).toBe(2000);
    expect(quitConfirmAckMs({ PLAYHOOK_QUIT_CONFIRM_ACK_MS: '500' })).toBe(500);
    expect(quitGraceMs({})).toBe(3000);
    expect(quitGraceMs({ PLAYHOOK_QUIT_GRACE_MS: 'never' })).toBe(3000);
  });
});
