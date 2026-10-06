import { redirectSystemPath } from '../+native-intent';

const go = (path: string) => redirectSystemPath({ path, initial: true });

test.each([
  ['roadwise://add/maya_16', '/add/maya_16'],
  ['roadwise://clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise:///clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise://drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1'],
  ['roadwise://auth/callback#access_token=x', '/auth/callback#access_token=x'],
  ['/clan/ABCD2345', '/clan/ABCD2345'],
])('%s passes as %s', (path, expected) => expect(go(path)).toBe(expected));

test.each(['roadwise://drive', 'roadwise://drive?start=1', 'roadwise://settings/account', 'roadwise://add/a/b', 'roadwise://', 'https://evil.test/clan/x', '/(app)/settings'])(
  '%s opens Home',
  (path) => expect(go(path)).toBe('/')
);
