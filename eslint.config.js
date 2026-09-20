const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*', 'ios/*', 'android/*', 'supabase/functions/*'] },
  // Maintenance scripts run under Node, not in the app bundle, so they need Node's globals
  // (`__dirname`) rather than the React Native ones. This *declares globals*; it ignores nothing
  // and disables no rule.
  {
    files: ['scripts/**/*.js', 'modules/**/scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
]);
