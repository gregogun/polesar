import js from '@eslint/js';
import oxlint from 'eslint-plugin-oxlint';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Keep in sync with ignorePatterns in .oxlintrc.json.
    ignores: ['node_modules', 'dist', 'build', 'coverage', '.output'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Disable all rules that oxlint already covers to avoid double-reporting.
  oxlint.buildFromOxlintConfigFile('.oxlintrc.json'),
  {
    rules: {
      // Prefer const where let is never reassigned.
      'prefer-const': 'error',
      // Type-aware rules oxlint can't cover yet.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
