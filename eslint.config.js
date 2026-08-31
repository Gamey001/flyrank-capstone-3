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
        // Config files sit outside the app's tsconfig include but still get
        // linted.
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // These print to stdout by design; that is their output, not debugging.
    files: ['scripts/**/*', 'src/db/seed.ts', 'src/db/migrate.ts', 'src/config/env.ts', 'test/**/*'],
    rules: { 'no-console': 'off' },
  },
);
