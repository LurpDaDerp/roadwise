module.exports = {
  preset: 'jest-expo',
  resolver: '<rootDir>/jest.resolver.js',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@supabase/.*|@expo/ui)',
    // Disable transforming the reanimated plugin in multi-platform tests, causing "Reentrant plugin detected trying to load react-native-reanimated/plugin.."
    '/node_modules/react-native-reanimated/plugin/',
    // Disable transforming the react-native babel preset, since it's part of the transformer itself
    '/node_modules/@react-native/babel-preset/',
  ],
  // Only the repo-root `supabase/` directory (pgTAP SQL tests) is off limits; `src/data/supabase`
  // holds real Jest suites, so anchor the pattern to <rootDir> instead of matching any segment.
  testPathIgnorePatterns: ['/node_modules/', '/ios/', '/android/', '<rootDir>/supabase/'],
};
