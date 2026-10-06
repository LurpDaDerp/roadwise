// T15 r2 (security m-1(b), Info-1): an OTA update is bundled on the publishing machine, so
// EXPO_PUBLIC_DIAGNOSTICS can be inlined from that shell into a production update. The embedded update
// channel is fixed in the native binary and no update can change it, so diagnostics are also off whenever
// the build's channel is 'production'. That covers the diagnostics surfaces: /dev/drive (and
// any link to them) and the drive battery recorder, which all ask diagnosticsEnabled().
import { render, screen } from '@testing-library/react-native';

import { DriveDiagnosticsRoute } from '../DriveDiagnosticsScreen';
import { diagnosticsEnabled } from '../flags';

const mockEnv = { diagnostics: true };
jest.mock('@/lib/env', () => ({
  get env() {
    return mockEnv;
  },
}));
const mockUpdates: { channel: string | null } = { channel: 'production' };
jest.mock('expo-updates', () => ({
  get channel() {
    return mockUpdates.channel;
  },
}));
jest.mock('expo-router', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Redirect: ({ href }: { href: string }) => <RNText testID="redirect">{href}</RNText>, useRouter: () => ({ back: jest.fn(), canGoBack: () => false }) };
});
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const g = globalThis as { __DEV__?: boolean };
const realDev = g.__DEV__;
const realFlag = process.env.EXPO_PUBLIC_DIAGNOSTICS;

beforeEach(() => {
  mockEnv.diagnostics = true;
  mockUpdates.channel = 'production';
  process.env.EXPO_PUBLIC_DIAGNOSTICS = '1';
  g.__DEV__ = false;
});
afterEach(() => {
  g.__DEV__ = realDev;
  if (realFlag === undefined) delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
  else process.env.EXPO_PUBLIC_DIAGNOSTICS = realFlag;
});


describe('diagnosticsEnabled()', () => {
  test('the flag set in a production-channel build (an OTA published with the flag): off', () => {
    expect(diagnosticsEnabled()).toBe(false);
  });
  test('even with __DEV__ (never true in a store build, but the channel wins)', () => {
    g.__DEV__ = true;
    expect(diagnosticsEnabled()).toBe(false);
  });
  test.each([['preview'], ['development'], [null]])('channel %p with the flag: on', (ch) => {
    mockUpdates.channel = ch;
    expect(diagnosticsEnabled()).toBe(true);
  });
  test('channel preview without the flag, not __DEV__: off', () => {
    mockUpdates.channel = 'preview';
    mockEnv.diagnostics = false;
    expect(diagnosticsEnabled()).toBe(false);
  });
});

describe('the surfaces', () => {
  test('/dev/drive: the same', async () => {
    await render(<DriveDiagnosticsRoute Hud={() => null} />);
    expect(screen.getByTestId('redirect').props.children).toBe('/');
  });
  test('the battery recorder is gated by diagnosticsEnabled() alone', () => {
    const root = path.join(__dirname, '..', '..', '..', '..');
    const boot = fs.readFileSync(path.join(root, 'src', 'boot', 'bootstrap.ts'), 'utf8');
    expect(boot).toMatch(/if \(!diagnosticsEnabled\(\)\) return \(\) => \{\};\s*const \{ createDriveBatteryRecorder \}/);
  });
});
