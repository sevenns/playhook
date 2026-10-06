import { describe, expect, it } from 'vitest';
import { describeConfirm, quitModeAction, type ConfirmContext } from '../src/renderer/confirm';
import { createTranslator } from '../src/shared/i18n/index';

function context(jobCount: number): ConfirmContext {
  return {
    game: undefined,
    browse: null,
    collision: null,
    deletesLocalGame: () => false,
    title: '',
    jobCount,
  };
}

const en = createTranslator('en');
const ru = createTranslator('ru');

describe('the quit question with background jobs', () => {
  it('names how many operations would be cancelled, with plural forms', () => {
    expect(describeConfirm('quit-with-jobs', context(1), en)?.message).toBe(
      '1 operation is in progress and will be cancelled. Quit anyway?',
    );
    expect(describeConfirm('quit-with-jobs', context(3), en)?.message).toBe(
      '3 operations are in progress and will be cancelled. Quit anyway?',
    );
    expect(describeConfirm('quit-with-jobs', context(1), ru)?.message).toBe(
      'Выполняется 1 операция, она будет отменена. Всё равно выйти?',
    );
    expect(describeConfirm('quit-with-jobs', context(3), ru)?.message).toBe(
      'Выполняются 3 операции, они будут отменены. Всё равно выйти?',
    );
    expect(describeConfirm('quit-with-jobs', context(5), ru)?.message).toBe(
      'Выполняется 5 операций, они будут отменены. Всё равно выйти?',
    );
  });

  it('falls back to the plain question once nothing is running any more', () => {
    expect(describeConfirm('quit-with-jobs', context(0), en)?.message).toBe('Quit Playhook?');
  });

  it('returns to the Power menu it was asked from', () => {
    expect(describeConfirm('quit-with-jobs', context(2), en)?.returnTo).toBe('power');
  });
});

describe('Shutdown and Reboot', () => {
  it('keep their own question without jobs and name the jobs when there are some', () => {
    expect(describeConfirm('shutdown', context(0), en)?.message).toBe('Shut down the PC?');
    expect(describeConfirm('reboot', context(0), en)?.message).toBe('Reboot the PC?');
    expect(describeConfirm('shutdown', context(2), en)?.message).toBe(
      '2 operations are in progress and will be cancelled. Shut down the PC anyway?',
    );
    expect(describeConfirm('reboot', context(1), en)?.message).toBe(
      '1 operation is in progress and will be cancelled. Reboot the PC anyway?',
    );
    expect(describeConfirm('sleep', context(4), en)?.message).toBe('Put the PC to sleep?');
  });
});

describe('quitModeAction', () => {
  it('maps the three exit questions onto their action and nothing else', () => {
    expect(quitModeAction('quit-with-jobs')).toBe('quit');
    expect(quitModeAction('shutdown')).toBe('shutdown');
    expect(quitModeAction('reboot')).toBe('reboot');
    expect(quitModeAction('sleep')).toBeNull();
    expect(quitModeAction('install')).toBeNull();
  });
});
