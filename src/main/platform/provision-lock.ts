/** An async queue: sections handed to `run` execute one at a time, in the order they were handed in. */
export interface ProvisionLock {
  run<T>(section: () => Promise<T>): Promise<T>;
}

/**
 * Creates a lock for the steps that must not overlap between games: winetricks shares one download cache
 * (`~/.cache/winetricks`) across every prefix and takes no lock of its own. A section that throws releases
 * the lock like one that succeeds.
 */
export function createProvisionLock(): ProvisionLock {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(section: () => Promise<T>): Promise<T> {
      const result = tail.then(section);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
