import { redirectSystemPath } from '../+native-intent';

const go = (path: string) => redirectSystemPath({ path, initial: true });

test.each([
  ['roadwise://add/maya_16', '/add/maya_16'],
  ['roadwise://clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise:///clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise://drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1'],
  ['roadwise://auth/callback#access_token=x', '/auth/callback#access_token=x'],
  ['/clan/ABCD2345', '/clan/ABCD2345'],
])('%s passes as %s', async (path, expected) => expect(await go(path)).toBe(expected));

test.each([
  'roadwise://drive',
  'roadwise://drive?start=1',
  // Home, and nothing a parameter could start: no link ever starts a drive.
  'roadwise://home',
  'roadwise:///home',
  'roadwise://home?start=1',
  'roadwise://settings/account',
  'roadwise://add/a/b',
  'roadwise://',
  'https://evil.test/clan/x',
  '/(app)/settings',
  'roadwise://settings/dashcam-setup',
  // A DashPal link of any shape (there is none: DashPals pair with one tap) opens Home.
  'roadwise://dashpal',
  'roadwise:///dashpal',
  'roadwise://dashpal?d=f412fa0c9e01',
  'roadwise://dashpal#d=f412fa0c9e01&k=000G40R40M30E209185GR38E1W60',
  'https://pair.example.com/dashpal#d=f412fa0c9e01&k=000G40R40M30E209185GR38E1W60',
  'roadwise://dashpal/setup',
])('%s opens Home', async (path) => expect(await go(path)).toBe('/'));

test('the dev client launcher links pass untouched', async () => {
  expect(await go('exp+roadwise://expo-development-client/?url=x')).toBe('exp+roadwise://expo-development-client/?url=x');
});
