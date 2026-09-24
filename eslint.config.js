// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  eslintConfigPrettier,
  {
    // demo/solana/internal-asset-program is its own self-contained Anchor
    // project (own package.json/tsconfig/dependency graph) — a reference
    // artifact, never linted as part of this repo's own codebase.
    ignores: ['dist/**', 'drizzle/**', 'node_modules/**', 'demo/solana/internal-asset-program/**'],
  },
);
