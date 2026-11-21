const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  // `.expo` holds the router's generated types, rewritten by every dev-server run and never
  // committed; linting it reports warnings about Expo's own generated header. `web/site-dist` is
  // the website's build output (`npm run site:build`), a git-ignored copy of web/link-site.
  { ignores: ['dist/*', 'ios/*', 'android/*', 'supabase/functions/*', '.expo/*', 'web/site-dist/*'] },
  // Maintenance scripts run under Node, not in the app bundle, so they need Node's globals
  // (`__dirname`) rather than the React Native ones. This *declares globals*; it ignores nothing
  // and disables no rule.
  // The app's own config plugins (plugins/) run under Node too, at prebuild.
  {
    files: ['scripts/**/*.js', 'modules/**/scripts/**/*.js', 'plugins/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
]);
