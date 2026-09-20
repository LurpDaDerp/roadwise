// RNTL v14 registers its jest matchers on import; the old `/extend-expect` entry point is gone.
import '@testing-library/react-native';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

// Safe-area insets are a native measurement that never arrives under Jest: the real
// `SafeAreaProvider` renders nothing until it does, and `useSafeAreaInsets` throws outside one.
// The library's own mock reports zero insets by default and honours `initialMetrics`, so a test
// can hand a screen Face ID-sized insets when the layout under test depends on them.
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default
);
