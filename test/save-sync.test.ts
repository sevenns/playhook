import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/main/save-sync';

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('withRetry (busy-file backoff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value when the operation succeeds on the first try', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const promise = withRetry(op);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable code (EBUSY) and eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockResolvedValue('done');
    const promise = withRetry(op);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('done');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const op = vi.fn().mockRejectedValue(fsError('ENOENT'));
    const promise = withRetry(op);
    const assertion = expect(promise).rejects.toThrow('ENOENT');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_ATTEMPTS and throws the last error', async () => {
    const op = vi.fn().mockRejectedValue(fsError('EBUSY'));
    const promise = withRetry(op);
    const assertion = expect(promise).rejects.toThrow('EBUSY');
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(5);
  });
});
