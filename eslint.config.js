import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/widget/widget.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // `allowDefaultProject` covers the config files that sit outside the
        // app's tsconfig include but still deserve linting.
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        // A leading underscore is the convention here for "deliberately
        // discarded" — the honeypot value destructured out of a payload, say.
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Scripts and the seed/migrate CLIs print to stdout by design — that is
    // their output, not stray debugging.
    files: ['scripts/**/*', 'src/db/seed.ts', 'src/db/migrate.ts', 'src/config/env.ts', 'test/**/*'],
    rules: { 'no-console': 'off' },
  },
);
