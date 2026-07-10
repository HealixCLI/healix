import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Globally ignored paths — build output, deps, configs, and generated suites.
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.config.*',
      '**/.healix/**',
      '**/__generated__/**',
      '**/generated/**',
      'TestBot_MCP/**',
    ],
  },

  // Lint TS/TSX/JS sources (so passing a directory discovers TypeScript files).
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
  },

  // Base JS + TypeScript recommended (NOT type-checked, for speed).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Repo-wide rule pragmatism so `pnpm lint` exits 0 on the current code.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Matching control characters is intentional here (e.g. stripping ANSI escape codes).
      'no-control-regex': 'off',
    },
  },

  // Node packages: CLI + core run on Node.
  {
    files: ['packages/**/*.ts', 'apps/desktop/src/main/**/*.ts', 'apps/desktop/src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Desktop renderer: browser + React hooks.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Prettier compatibility — MUST be last to disable conflicting stylistic rules.
  prettier,
);
