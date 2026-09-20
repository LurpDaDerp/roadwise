// Reanimated 4 reaches for react-native-worklets' TurboModule at import time, which does not
// exist under Jest. The worklets package ships a resolver that drops the `.native` platform
// extensions so the pure-JS implementation is picked instead; jest-expo already owns the
// `resolver` slot, so chain the two rather than replace one with the other.
const reactNativeResolver = require('@react-native/jest-preset/jest/resolver.js');

module.exports = (request, options) => {
  const isWorklets =
    options.basedir.includes('react-native-worklets') || request.includes('react-native-worklets');
  const next = isWorklets
    ? { ...options, extensions: options.extensions?.filter((ext) => !ext.includes('native')) }
    : options;
  return reactNativeResolver(request, next);
};
