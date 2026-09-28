import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
export default defineConfig([
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/*.js',
      'tests/**',
      'runs/**',
      'models/**',
      '.venv*/**',
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Node-only CLI adapters are never bundled into the Obsidian plugin.
    files: ['src/cli/**/*.ts'],
    languageOptions: { globals: { process: 'readonly' } },
    rules: {
      'obsidianmd/no-nodejs-modules': 'off',
      'no-restricted-globals': 'off',
      'obsidianmd/rule-custom-message': 'off',
      'no-new-func': 'error',
    },
  },
]);
