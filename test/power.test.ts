// PowerService unit tests. The service is pure/electron/koffi-free on import (the OS commands are behind
// the injected PowerBackend, the app quit and the error channel are injected too), so it runs in plain
// Node with fakes — no Windows, no electron. We assert: the backend action chosen per menu item, the
// unsupported-platform guard (nothing runs, error surfaced), quit after shutdown/reboot but NOT after
// sleep, and that a backend failure is surfaced to the error callback (and does not quit).
import { describe, expect, it, vi } from 'vitest';
import { createPowerService, type PowerServiceDeps } from '../src/main/power';
import type { PowerBackend } from '../src/main/platform';
import { createTranslator } from '../src/shared/i18n/index';

const t = createTranslator('en');

function makeBackend(overrides: Partial<PowerBackend> = {}): PowerBackend {
  return {
    supported: true,
    run: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function makeDeps(backend: PowerBackend, overrides: Partial<PowerServiceDeps> = {}): PowerServiceDeps {
  return {
    backend,
    quit: vi.fn(),
    showError: vi.fn(),
    getTranslator: () => t,
    ...overrides,
  };
}

describe('PowerService', () => {
  it('shutdown runs the backend then quits', async () => {
    const backend = makeBackend();
    const deps = makeDeps(backend);
    await createPowerService(deps).perform('shutdown');
    expect(backend.run).toHaveBeenCalledWith('shutdown');
    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(backend.suspend).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('reboot runs the backend then quits', async () => {
    const backend = makeBackend();
    const deps = makeDeps(backend);
    await createPowerService(deps).perform('reboot');
    expect(backend.run).toHaveBeenCalledWith('reboot');
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it('sleep suspends in place — no run, no quit', async () => {
    const backend = makeBackend();
    const deps = makeDeps(backend);
    await createPowerService(deps).perform('sleep');
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(backend.run).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('unsupported backend: nothing runs, an error is surfaced', async () => {
    const backend = makeBackend({ supported: false });
    const deps = makeDeps(backend);
    await createPowerService(deps).perform('shutdown');
    expect(backend.run).not.toHaveBeenCalled();
    expect(backend.suspend).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith(t('errors.powerUnsupported'));
  });

  it('a backend run failure is surfaced and does NOT quit', async () => {
    const backend = makeBackend({ run: vi.fn(() => Promise.reject(new Error('boom'))) });
    const deps = makeDeps(backend);
    await createPowerService(deps).perform('shutdown');
    expect(deps.showError).toHaveBeenCalledWith(t('errors.powerFailed', { cause: 'boom' }));
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('a suspend failure is surfaced and does NOT quit', async () => {
    const backend = makeBackend({
      suspend: vi.fn(() => Promise.reject(new Error('systemctl suspend failed'))),
    });
    const deps = makeDeps(backend);
    await createPowerService(deps).perform('sleep');
    expect(deps.showError).toHaveBeenCalledWith(
      t('errors.powerFailed', { cause: 'systemctl suspend failed' }),
    );
    expect(deps.quit).not.toHaveBeenCalled();
  });
});
