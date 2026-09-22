module.exports = {
  preset: 'jest-expo',
  resolver: '<rootDir>/jest.resolver.js',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@supabase/.*|@expo/ui|standard-navigation)',
    // Disable transforming the reanimated plugin in multi-platform tests, causing "Reentrant plugin detected trying to load react-native-reanimated/plugin.."
    '/node_modules/react-native-reanimated/plugin/',
    // Disable transforming the react-native babel preset, since it's part of the transformer itself
    '/node_modules/@react-native/babel-preset/',
  ],
  // Every project-owned pattern is anchored to <rootDir>: only the generated CNG projects and the
  // repo-root `supabase/` directory (pgTAP SQL tests) are off limits. Unanchored `/ios/` and
  // `/android/` would also swallow tests under `modules/*/ios|android`, and `src/data/supabase`
  // holds real Jest suites.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/ios/',
    '<rootDir>/android/',
    '<rootDir>/supabase/',
  ],
};
