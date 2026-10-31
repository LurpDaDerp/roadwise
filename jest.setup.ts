// RNTL v14 registers its jest matchers on import; the old `/extend-expect` entry point is gone.
import '@testing-library/react-native';
// Gesture Handler's own native-module mocks, so a `GestureDetector` renders and `fireGestureHandler` drives it.
import 'react-native-gesture-handler/jestSetup';
import type { ComponentType, ReactElement, ReactNode } from 'react';

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

// expo-observe's native module is absent under Jest: the real package imports, but installs a
// global error handler on import and warns on every report. A stand-in with the same surface: the
// calls are jest.fn()s a test can assert on, and the error boundary catches and renders its
// fallback (`{ error, resetError }`) as the real one does.
type MockObserveFallback = ReactElement | null | ((props: { error: unknown; resetError: () => void }) => ReactNode);
type MockObserveBoundaryProps = { fallback: MockObserveFallback; children?: ReactNode };
jest.mock('expo-observe', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Observe = {
    configure: jest.fn(),
    reportError: jest.fn(),
    logEvent: jest.fn(),
    markInteractive: jest.fn(),
    dispatchEvents: jest.fn(async () => {}),
    getIntegrations: jest.fn(() => ({})),
    registerIntegration: jest.fn(),
  };
  class ObserveErrorBoundary extends React.Component<MockObserveBoundaryProps, { hasError: boolean; error: unknown }> {
    state = { hasError: false, error: null as unknown };
    static getDerivedStateFromError(error: unknown) {
      return { hasError: true, error };
    }
    componentDidCatch(error: unknown) {
      Observe.reportError(error);
    }
    resetError = () => this.setState({ hasError: false, error: null });
    render() {
      if (!this.state.hasError) return this.props.children;
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback({ error: this.state.error, resetError: this.resetError }) : fallback;
    }
  }
  const ObserveRoot = Object.assign(({ children }: { children: ReactNode }) => children, {
    wrap: <P,>(Component: ComponentType<P>) => Component,
  });
  return {
    __esModule: true,
    default: Observe,
    Observe,
    AppMetrics: Observe,
    ObserveErrorBoundary,
    ObserveRoot,
    ObserveInteractiveMarker: () => null,
    useObserve: () => ({ markInteractive: Observe.markInteractive }),
  };
});
