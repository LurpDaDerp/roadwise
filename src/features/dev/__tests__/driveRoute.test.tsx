// `/(app)/dev/drive` reaches the diagnostics screen through a build-time gate (the flag or
// `__DEV__`), as `/(app)/dev/ui` reaches the gallery: a store build folds it to `false` and neither
// bundles nor loads the screen, its self-test (with the detector's decision table) or its simulation.
// A development or diagnostics build opens the screen as before (its own guard, the update channel,
// is tested in channelGate.test.tsx).
import { render, screen } from '@testing-library/react-native';
import type { ComponentType } from 'react';

import DriveDiagnosticsPage from '../../../../app/(app)/dev/drive';

// A `var`: the hoisted factory below would run before this line if the route imported the screen.
// eslint-disable-next-line no-var
var mockScreen: { loads: number } | undefined;
jest.mock('@/features/dev/DriveDiagnosticsScreen', () => {
  mockScreen ??= { loads: 0 };
  mockScreen.loads += 1;
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    DriveDiagnosticsRoute: ({ Hud }: { Hud: ComponentType }) => (
      <>
        <Text testID="diagnostics">diagnostics</Text>
        <Hud />
      </>
    ),
  };
});
jest.mock('@/features/drive/HudScreen', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { HudScreen: ({ overlay }: { overlay?: boolean }) => <Text testID="hud">{overlay ? 'overlay' : 'screen'}</Text> };
});
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text> };
});

const g = globalThis as { __DEV__?: boolean };
const realDev = g.__DEV__;
const realFlag = process.env.EXPO_PUBLIC_DIAGNOSTICS;

beforeEach(() => {
  mockScreen = { loads: 0 };
  delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
  g.__DEV__ = false;
});
afterEach(() => {
  g.__DEV__ = realDev;
  if (realFlag === undefined) delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
  else process.env.EXPO_PUBLIC_DIAGNOSTICS = realFlag;
});

test('a store build (no flag, not __DEV__) is sent home and never loads the screen', async () => {
  await render(<DriveDiagnosticsPage />);
  expect(screen.getByTestId('redirect').props.children).toBe('/');
  expect(screen.queryByTestId('diagnostics')).toBeNull();
  expect(mockScreen?.loads).toBe(0);
});

test('a diagnostics build opens the screen with the simulation HUD drawn as the overlay', async () => {
  process.env.EXPO_PUBLIC_DIAGNOSTICS = '1';
  await render(<DriveDiagnosticsPage />);
  expect(screen.getByTestId('diagnostics')).toBeTruthy();
  expect(screen.getByTestId('hud').props.children).toBe('overlay');
  expect(screen.queryByTestId('redirect')).toBeNull();
});

test('a development build opens it too', async () => {
  g.__DEV__ = true;
  await render(<DriveDiagnosticsPage />);
  expect(screen.getByTestId('diagnostics')).toBeTruthy();
  expect(screen.queryByTestId('redirect')).toBeNull();
});
