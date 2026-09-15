// Flat ESLint config. Type-aware linting over src/ with the high-value async-safety rules:
// no-floating-promises / no-misused-promises catch forgotten awaits, and
// strict-boolean-expressions catches implicit nullable/number truthiness. eslint-config-prettier is
// applied last so no lint rule fights the formatter. Tests are linted too (they are part of the
// typechecked program), minus two rules that only ever fire on their fakes; build output is not.
// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'release/**', 'scripts/**', '*.config.*'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md's "no non-null `!`" rule, actually enforced. tsc cannot express it and
      // recommendedTypeChecked does not carry it, so until now the rule lived on discipline alone — and
      // `src/` kept it while `test/` quietly grew a dozen of them.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          // The codebase already writes explicit comparisons (=== true, !== undefined, .length > 0);
          // these options keep the rule aligned with that style without a mechanical rewrite.
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
        },
      ],
    },
  },
  {
    // CLAUDE.md's platform-layer rule ("all OS-specific behaviour lives behind the `Platform` bundle, not
    // scattered `process.platform` checks"), enforced. The allowlist below is every file where a direct
    // check is the RIGHT thing, each with its reason; anything else is a behavioural branch that belongs
    // on a `Platform` interface — the win32-only helpers (game-launcher.ts, registry.ts,
    // uninstaller.win32.ts) are reached only through the win32 bundle, so they need no guard of their
    // own. A per-line `eslint-disable` is not the way out — the repo has none, and that is worth keeping.
    files: ['src/main/**/*.ts'],
    ignores: [
      // The platform layer itself: this is where the OS is meant to be asked.
      'src/main/platform/**',
      // Bootstrap and electron-UI glue that select the bundle or an OS-specific electron behaviour once
      // (application menu, dock hide, tray icon format, simple-fullscreen, log/config directories).
      'src/main/main.ts',
      'src/main/window.ts',
      'src/main/tray.ts',
      'src/main/logger.ts',
      'src/main/config-paths.ts',
      // electron-updater environment detection (AppImage vs macOS) — about the updater's runtime, not
      // about a game.
      'src/main/updater.ts',
      // Self-guards of the win32-only FFI modules: they must refuse to bind koffi anywhere but Windows
      // BEFORE any Platform object exists.
      'src/main/foreground.ts',
      'src/main/window-finder.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='platform']",
          message:
            'OS-specific behaviour belongs on a `Platform` interface (src/main/platform/types.ts), not on a process.platform check here. See CLAUDE.md "Platform layer".',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // A fake implementing an async interface has nothing to await, and an assertion on a fake's method
      // references it unbound on purpose — both fire on every test double, and neither says anything.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // A fake's signature is dictated by the interface it stands in for, so a parameter it has no use
      // for is marked with the leading underscore src already uses for the same thing (`_event`).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
);
