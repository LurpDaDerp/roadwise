import { redirectSystemPath } from '../+native-intent';

// The link domain (`extra.linkDomain`): none by default, as now; a test sets one.
let mockDomain: string | null = null;
jest.mock('@/lib/linkDomain', () => ({ linkDomain: () => mockDomain }));
beforeEach(() => {
  mockDomain = null;
});

const go = (path: string) => redirectSystemPath({ path, initial: true });

test.each([
  ['roadwise://add/maya_16', '/add/maya_16'],
  ['roadwise:///add/maya_16', '/add/maya_16'],
  ['roadwise://drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1'],
  ['/add/maya_16', '/add/maya_16'],
  // The Live Activity and the widget open the driving screen (it shows only a drive already recording).
  ['roadwise://drive', '/drive'],
  ['roadwise:///drive', '/drive'],
  // A shared Wrapped, the archive and one month of it (the push on the 1st opens the month).
  ['roadwise://w/Ab3dEf7hJk9m', '/w/Ab3dEf7hJk9m'],
  ['roadwise:///w/Ab3dEf7hJk9m', '/w/Ab3dEf7hJk9m'],
  // A trailing slash, query or fragment is dropped: the route is the id alone.
  ['roadwise://w/Ab3dEf7hJk9m/', '/w/Ab3dEf7hJk9m'],
  ['roadwise://w/Ab3dEf7hJk9m?x=1', '/w/Ab3dEf7hJk9m'],
  ['roadwise://wrapped', '/wrapped'],
  ['roadwise://wrapped/2026-10', '/wrapped/2026-10'],
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
  // Wrapped links of any other shape.
  'roadwise://w/short',
  'roadwise://w/Ab3dEf7hJk9m/extra',
  'roadwise://w/Ab3dEf7hJk9-',
  'roadwise://w/Ab3dEf7hJk9m%2F..',
  'roadwise://wrapped/2026-13',
  'roadwise://wrapped/2026-1',
  'roadwise://wrapped/2026-10?start=1',
  // No link domain is set: no web link opens anything, a Wrapped one included.
  'https://roadwise.app/w/Ab3dEf7hJk9m',
])('%s opens Home', async (path) => expect(await go(path)).toBe('/'));

test('the dev client launcher links pass untouched in a development build', async () => {
  expect(await go('exp+roadwise://expo-development-client/?url=x')).toBe('exp+roadwise://expo-development-client/?url=x');
});

test.each([
  // Only a real launcher link passes: the words anywhere else in a link do not skip the allowlist.
  'roadwise://settings/dashcam?aim=1&x=expo-development-client',
  'roadwise://drive?expo-development-client',
  'roadwise://friends/scan#expo-development-client',
  'roadwise://settings/delete-account?expo-development-client',
  'roadwise://expo-development-client',
  'https://evil.test/exp+roadwise://expo-development-client/',
])('%s opens Home', async (path) => expect(await go(path)).toBe('/'));

describe('in a release build', () => {
  const g = globalThis as unknown as { __DEV__: boolean };
  let dev: boolean;
  beforeEach(() => {
    dev = g.__DEV__;
    g.__DEV__ = false;
  });
  afterEach(() => {
    g.__DEV__ = dev;
  });

  test('a dev client launcher link goes through the allowlist and opens Home', async () => {
    expect(await go('exp+roadwise://expo-development-client/?url=x')).toBe('/');
  });

  test('the app links still pass', async () => {
    expect(await go('roadwise://drive')).toBe('/drive');
  });
});

test('the Live Activity and Dynamic Island link reaches the driving screen on a cold launch and on a warm one alike', async () => {
  for (const initial of [true, false]) {
    expect(await redirectSystemPath({ path: 'roadwise://drive', initial })).toBe('/drive');
  }
});

describe('with a link domain set', () => {
  beforeEach(() => {
    mockDomain = 'roadwise.app';
  });

  test.each([
    ['https://roadwise.app/w/Ab3dEf7hJk9m', '/w/Ab3dEf7hJk9m'],
    ['https://RoadWise.app/w/Ab3dEf7hJk9m/', '/w/Ab3dEf7hJk9m'],
    // Tracking parameters other apps add to a tapped link are dropped.
    ['https://roadwise.app/w/Ab3dEf7hJk9m?utm_source=instagram&igshid=x', '/w/Ab3dEf7hJk9m'],
    ['https://roadwise.app/w/Ab3dEf7hJk9m/?fbclid=IwAR0abc', '/w/Ab3dEf7hJk9m'],
    ['https://roadwise.app/w/Ab3dEf7hJk9m#x', '/w/Ab3dEf7hJk9m'],
  ])('%s passes as %s', async (path, expected) => expect(await go(path)).toBe(expected));

  test.each([
    // Only https, only that host, only a Wrapped path.
    'http://roadwise.app/w/Ab3dEf7hJk9m',
    'https://evil.test/w/Ab3dEf7hJk9m',
    'https://roadwise.app.evil.test/w/Ab3dEf7hJk9m',
    'https://evil.test/roadwise.app/w/Ab3dEf7hJk9m',
    'https://roadwise.app/add/maya_16',
    'https://roadwise.app/drives/abc',
    'https://roadwise.app/w/Ab3dEf7hJk9m/extra',
    'https://roadwise.app.evil.test/w/Ab3dEf7hJk9m?x=roadwise.app',
    'https://roadwise.app/w/short',
    'https://roadwise.app/wrapped/2026-10',
  ])('%s opens Home', async (path) => expect(await go(path)).toBe('/'));
});
