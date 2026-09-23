// The DMS diagnostics route (plan Task 16, R-2; rev1 S-M3): a build without the diagnostics flag, and not
// __DEV__, is sent home and never loads the panel or the native wrapper. DmsDiagnosticsBundle.test.ts
// proves the same at the bundle level (the production transform drops both requires).
import { render, screen } from '@testing-library/react-native';
import type { ComponentType } from 'react';

const mockEnv = { diagnostics: false };
jest.mock('@/lib/env', () => ({
  get env() {
    return mockEnv;
  },
}));

jest.mock('expo-router', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Redirect: ({ href }: { href: string }) => <RNText testID="redirect">{href}</RNText> };
});

const mockLoads = { panel: 0, wrapper: 0 };
jest.mock('@/features/dev/DmsDiagnosticsPanel', () => {
  mockLoads.panel++;
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { DmsDiagnosticsScreen: ({ native }: { native: unknown }) => <RNText testID="panel">{native === mockWrapper ? 'wrapper' : 'other'}</RNText> };
});
const mockWrapper = { isAvailable: () => false };
jest.mock('../../../../modules/dms-vision', () => {
  mockLoads.wrapper++;
  return { __esModule: true, default: mockWrapper };
});

const g = globalThis as { __DEV__?: boolean };
const realDev = g.__DEV__;
const realFlag = process.env.EXPO_PUBLIC_DIAGNOSTICS;

function loadRoute(): ComponentType {
  let Page: ComponentType | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry per test
    Page = (require('../../../../app/(app)/dev/dms') as { default: ComponentType }).default;
  });
  return Page!;
}

beforeEach(() => {
  mockLoads.panel = 0;
  mockLoads.wrapper = 0;
  mockEnv.diagnostics = false;
  delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
});
afterEach(() => {
  g.__DEV__ = realDev;
  if (realFlag === undefined) delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
  else process.env.EXPO_PUBLIC_DIAGNOSTICS = realFlag;
});

describe('the route guard', () => {
  test('no flag and not __DEV__: sent home, and neither the panel nor the wrapper is ever loaded', async () => {
    g.__DEV__ = false;
    const Page = loadRoute();
    await render(<Page />);
    expect(screen.getByTestId('redirect').props.children).toBe('/');
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(mockLoads).toEqual({ panel: 0, wrapper: 0 });
  });

  test('the flag (EXPO_PUBLIC_DIAGNOSTICS=1): the panel, handed the native wrapper', async () => {
    g.__DEV__ = false;
    mockEnv.diagnostics = true;
    process.env.EXPO_PUBLIC_DIAGNOSTICS = '1';
    const Page = loadRoute();
    await render(<Page />);
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(screen.getByTestId('panel').props.children).toBe('wrapper');
    expect(mockLoads.panel).toBe(1);
  });

  test('__DEV__: the panel', async () => {
    g.__DEV__ = true;
    const Page = loadRoute();
    await render(<Page />);
    expect(screen.getByTestId('panel')).toBeTruthy();
  });

  test('any flag value other than "1" is off', async () => {
    g.__DEV__ = false;
    process.env.EXPO_PUBLIC_DIAGNOSTICS = 'true';
    const Page = loadRoute();
    await render(<Page />);
    expect(screen.getByTestId('redirect').props.children).toBe('/');
    expect(mockLoads).toEqual({ panel: 0, wrapper: 0 });
  });
});
