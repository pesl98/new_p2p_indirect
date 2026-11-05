import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const rules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off',
  'no-regex-spaces': 'off',
  'no-useless-assignment': 'warn',
  'preserve-caught-error': 'off'
};

export default [
  { ignores: ['**/node_modules/**', 'client/dist/**', 'public/**'] },
  js.configs.recommended,
  { files: ['server/**/*.js', 'api/**/*.js', 'shared/**/*.js', 'scripts/**/*.js', 'client/src/**/*.test.js'], languageOptions: { globals: globals.node }, rules },
  {
    files: ['client/**/*.{js,jsx}'],
    ignores: ['client/src/**/*.test.js', 'client/*.config.js'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { ...rules, 'react-hooks/rules-of-hooks': 'error' }
  },
  { files: ['client/*.config.js'], languageOptions: { globals: globals.node }, rules }
];
