// Flat ESLint config (audit I4). Type-aware linting over src/ with the high-value async-safety rules
// the audit calls out: no-floating-promises / no-misused-promises catch forgotten awaits, and
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
