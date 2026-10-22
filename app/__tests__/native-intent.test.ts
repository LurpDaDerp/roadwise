import { redirectSystemPath } from '../+native-intent';

const go = (path: string) => redirectSystemPath({ path, initial: true });

test.each([
  ['roadwise://add/maya_16', '/add/maya_16'],
  ['roadwise:///add/maya_16', '/add/maya_16'],
  ['roadwise://drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1'],
  ['/add/maya_16', '/add/maya_16'],
  // The Live Activity and the widget open the driving screen (it shows only a drive already recording).
  ['roadwise://drive', '/drive'],
  ['roadwise:///drive', '/drive'],
])('%s passes as %s', async (path, expected) => expect(await go(path)).toBe(expected));

test.each([
  // Clan invites are gone with clans: an old invite link opens Home.
  'roadwise://clan/ABCD2345',
  'roadwise:///clan/ABCD2345',
  '/clan/ABCD2345',
  // Only the exact link: a drive link with parameters opens Home, so no link can start a drive.
  'roadwise://drive?start=1',
  'roadwise://drive/start',
  'roadwise://drive#start',
  // Sign-in is a code typed into the app: no link signs anyone in.
  'roadwise://auth/callback#access_token=x',
  'roadwise://auth/callback?code=x',
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

test('the Live Activity and Dynamic Island link reaches the driving screen on a cold launch and on a warm one alike', async () => {
  for (const initial of [true, false]) {
    expect(await redirectSystemPath({ path: 'roadwise://drive', initial })).toBe('/drive');
  }
});
