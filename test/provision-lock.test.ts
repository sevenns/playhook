import { describe, expect, it } from 'vitest';
import { createProvisionLock } from '../src/main/platform/provision-lock';

/** A promise the test settles by hand. */
function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: () => resolve(), reject: (error) => reject(error) };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ProvisionLock', () => {
  it('runs the sections one at a time, in the order they were handed in', async () => {
    const lock = createProvisionLock();
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    const a = lock.run(async () => {
      log.push('a:start');
      await first.promise;
      log.push('a:end');
    });
    const b = lock.run(async () => {
      log.push('b:start');
      await second.promise;
      log.push('b:end');
    });
    const c = lock.run(async () => {
      log.push('c');
      return 42;
    });
    await flush();
    expect(log).toEqual(['a:start']);
    first.resolve();
    await a;
    await flush();
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
    second.resolve();
    await b;
    await expect(c).resolves.toBe(42);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c']);
  });

  it('releases the lock when a section throws, and hands the error to its own caller only', async () => {
    const lock = createProvisionLock();
    const failing = deferred();
    const a = lock.run(() => failing.promise);
    const b = lock.run(async () => 'next');
    failing.reject(new Error('winetricks boom'));
    await expect(a).rejects.toThrow('winetricks boom');
    await expect(b).resolves.toBe('next');
  });
});
