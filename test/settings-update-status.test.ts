// The Updates section's wording and primary action, per UpdateStatus. settings-form-view.ts is DOM code,
// but these two functions are pure (a status in, text/an action out) and importable in plain node — which
// is what makes the one case with no visible button, and the one that differs only by `reason`, testable
// at all.
import { describe, expect, it } from 'vitest';
import { updateAction, updateStatusText } from '../src/renderer/settings-form-view';
import { createTranslator } from '../src/shared/i18n/index';

const t = createTranslator('en');

describe('updateStatusText — the two "unsupported" situations', () => {
  it('tells a macOS user what to do instead of updating in place', () => {
    const text = updateStatusText({ kind: 'unsupported', reason: 'platform' }, t);
    expect(text).toContain('macOS');
    expect(text).toContain('.dmg');
  });

  it('keeps the dev-build wording for a non-packaged run', () => {
    expect(updateStatusText({ kind: 'unsupported', reason: 'not-packaged' }, t)).toBe(
      'Updates are available only in the installed build.',
    );
  });

  it('says the two apart — a shared sentence would be wrong for one of them', () => {
    expect(updateStatusText({ kind: 'unsupported', reason: 'platform' }, t)).not.toBe(
      updateStatusText({ kind: 'unsupported', reason: 'not-packaged' }, t),
    );
  });
});

describe('updateAction — nothing to press when self-update is impossible', () => {
  it('offers no action for either unsupported reason', () => {
    expect(updateAction({ kind: 'unsupported', reason: 'platform' }, t)).toBeNull();
    expect(updateAction({ kind: 'unsupported', reason: 'not-packaged' }, t)).toBeNull();
  });

  it('still offers a check on an ordinary idle build', () => {
    expect(updateAction({ kind: 'idle' }, t)?.kind).toBe('check');
  });
});
