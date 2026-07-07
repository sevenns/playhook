// PowerService unit tests. The service is pure/electron/koffi-free on import (the FFI sleep, the
// `shutdown` exec, the app quit and the error channel are all injected), so it runs in plain Node with
// fake deps — no Windows, no electron. We assert: the command chosen per action, the win32 platform
// guard (nothing runs off Windows), quit after shutdown/reboot but NOT after sleep, and that an exec
// failure is surfaced to the error callback (and does not quit).
import { describe, expect, it, vi } from 'vitest';
import { createPowerService, type PowerServiceDeps } from '../src/main/power';
import { createTranslator } from '../src/shared/i18n/index';

const t = createTranslator('en');

function makeDeps(overrides: Partial<PowerServiceDeps> = {}): PowerServiceDeps {
  return {
    platform: 'win32',
    exec: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(),
    quit: vi.fn(),
    showError: vi.fn(),
    getTranslator: () => t,
    ...overrides,
  };
}

describe('PowerService', () => {
  it('shutdown runs `shutdown /s /t 0` then quits', async () => {
    const deps = makeDeps();
    await createPowerService(deps).perform('shutdown');
    expect(deps.exec).toHaveBeenCalledWith('shutdown', ['/s', '/t', '0']);
    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(deps.suspend).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('reboot runs `shutdown /r /t 0` then quits', async () => {
    const deps = makeDeps();
    await createPowerService(deps).perform('reboot');
    expect(deps.exec).toHaveBeenCalledWith('shutdown', ['/r', '/t', '0']);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it('sleep suspends in place — no exec, no quit', async () => {
    const deps = makeDeps();
    await createPowerService(deps).perform('sleep');
    expect(deps.suspend).toHaveBeenCalledTimes(1);
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it('off Windows: nothing runs, an error is surfaced', async () => {
    const deps = makeDeps({ platform: 'darwin' });
    await createPowerService(deps).perform('shutdown');
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.suspend).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith(t('errors.powerUnsupported'));
  });

  it('an exec failure is surfaced and does NOT quit', async () => {
    const deps = makeDeps({ exec: vi.fn(() => Promise.reject(new Error('boom'))) });
    await createPowerService(deps).perform('shutdown');
    expect(deps.showError).toHaveBeenCalledWith(t('errors.powerFailed', { cause: 'boom' }));
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('a suspend (FFI) failure is surfaced and does NOT quit', async () => {
    const deps = makeDeps({
      suspend: vi.fn(() => {
        throw new Error('SetSuspendState failed');
      }),
    });
    await createPowerService(deps).perform('sleep');
    expect(deps.showError).toHaveBeenCalledWith(
      t('errors.powerFailed', { cause: 'SetSuspendState failed' }),
    );
    expect(deps.quit).not.toHaveBeenCalled();
  });
});
