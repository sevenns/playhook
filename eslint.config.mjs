// Flat ESLint config (audit I4). Type-aware linting over src/ with the high-value async-safety rules
// the audit calls out: no-floating-promises / no-misused-promises catch forgotten awaits, and
// strict-boolean-expressions catches implicit nullable/number truthiness. eslint-config-prettier is
// applied last so no lint rule fights the formatter. Tests and build output are not linted (they live
// outside the typechecked src program).
// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'release/**', 'scripts/**', 'test/**', '*.config.*'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
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
  prettier,
);
