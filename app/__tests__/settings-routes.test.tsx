/**
 * Lane C: the settings routes are wired. Each route file renders its own screen, every href the
 * settings screens push resolves to a route file, and the camera route (lane B's) is linked, not
 * owned, here.
 */
import { render, screen } from '@testing-library/react-native';

import { SETTINGS_HREFS } from '@/features/settings/routes';

import AlertsRoute from '../(app)/settings/alerts';
import DeleteAccountRoute from '../(app)/settings/delete-account';
import HelpRoute from '../(app)/settings/help';
import SettingsRoute from '../(app)/settings/index';
import PrivacyRoute from '../(app)/settings/privacy';
import ProfileRoute from '../(app)/settings/profile';

function mockStub(name: string) {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return function Stub() {
    return <RNText testID={name}>{name}</RNText>;
  };
}
jest.mock('@/features/settings', () => ({
  SettingsScreen: mockStub('SettingsScreen'),
  ProfileScreen: mockStub('ProfileScreen'),
  AlertsScreen: mockStub('AlertsScreen'),
  PrivacyScreen: mockStub('PrivacyScreen'),
  DeleteAccountScreen: mockStub('DeleteAccountScreen'),
  HelpScreen: mockStub('HelpScreen'),
}));

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const fs = require('node:fs') as { existsSync: (file: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...parts: string[]) => string; resolve: (...parts: string[]) => string };
const APP = path.resolve(__dirname, '..');

test.each([
  [SettingsRoute, 'SettingsScreen'],
  [ProfileRoute, 'ProfileScreen'],
  [AlertsRoute, 'AlertsScreen'],
  [PrivacyRoute, 'PrivacyScreen'],
  [DeleteAccountRoute, 'DeleteAccountScreen'],
  [HelpRoute, 'HelpScreen'],
])('%p renders %s', async (Route, name) => {
  await render(<Route />);
  expect(screen.getByTestId(name)).toBeOnTheScreen();
});

test('every settings href has its route file', () => {
  const files: Record<string, string> = {
    root: '(app)/settings/index.tsx',
    profile: '(app)/settings/profile.tsx',
    alerts: '(app)/settings/alerts.tsx',
    camera: '(app)/settings/camera.tsx',
    notifications: '(app)/settings/notifications.tsx',
    privacy: '(app)/settings/privacy.tsx',
    deleteAccount: '(app)/settings/delete-account.tsx',
    help: '(app)/settings/help.tsx',
    detection: '(app)/permissions/auto-record.tsx',
    scoring: '(app)/insights/how-scoring-works.tsx',
  };
  expect(Object.keys(files).sort()).toEqual(Object.keys(SETTINGS_HREFS).sort());
  for (const file of Object.values(files)) expect(fs.existsSync(path.join(APP, file))).toBe(true);
});
