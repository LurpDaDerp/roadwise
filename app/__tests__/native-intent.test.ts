import { formatCode } from '@/dashcam/label';
import { createDashpalSecrets, type DashpalSecrets } from '@/dashcam/secure';

import { redirectSystemPath } from '../+native-intent';

const DOMAIN = 'pair.example.com';
const CODE = '000G40R40M30E209185GR38E1W60';
const ONCE = 'C944BA9XVGR6PTJDKBQ2BR9W54RG';
const CAM = 'f412fa0c9e01';

function memSecrets(o: { failWrites?: boolean } = {}) {
  const store = new Map<string, string>();
  const secrets: DashpalSecrets = createDashpalSecrets(() => ({
    getItemAsync: async (k) => store.get(k) ?? null,
    setItemAsync: async (k, v) => {
      if (o.failWrites) throw new Error('keychain locked');
      store.set(k, v);
    },
    deleteItemAsync: async (k) => void store.delete(k),
  }));
  return { store, secrets };
}

const go = (path: string, s = memSecrets()) => redirectSystemPath({ path, initial: true }, { domain: DOMAIN, secrets: s.secrets, now: () => 1000 });

test.each([
  ['roadwise://add/maya_16', '/add/maya_16'],
  ['roadwise://clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise:///clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise://drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1'],
  ['roadwise://auth/callback#access_token=x', '/auth/callback#access_token=x'],
  ['/clan/ABCD2345', '/clan/ABCD2345'],
  ['roadwise://dashpal', '/dashpal'],
  ['roadwise:///dashpal', '/dashpal'],
  ['roadwise://dashpal?src=box', '/dashpal'],
  [`roadwise://dashpal?d=${CAM}`, `/dashpal?d=${CAM}`],
  [`https://${DOMAIN}/dashpal`, '/dashpal'],
  [`https://${DOMAIN}/dashpal#d=${CAM.toUpperCase()}`, `/dashpal?d=${CAM}`],
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
  `https://evil.test/dashpal#d=${CAM}&k=${CODE}`,
  `https://${DOMAIN}/clan/ABCD2345`,
  `https://${DOMAIN}/other`,
  '/(app)/settings',
  'roadwise://dashpal/setup',
  'roadwise://dashpalx',
  'roadwise://settings/dashcam-setup',
])('%s opens Home', async (path) => expect(await go(path)).toBe('/'));

test('a label link with its code: the code goes to SecureStore and the route carries only the dashcam id', async () => {
  const s = memSecrets();
  const route = await go(`https://${DOMAIN}/dashpal#d=${CAM}&k=${CODE}`, s);
  expect(route).toBe(`/dashpal?d=${CAM}`);
  expect(route).not.toContain('k=');
  expect(await s.secrets.readPendingCode(1000)).toEqual({ at: 1000, dashcamId: CAM, code: CODE });
  // the custom scheme with a code (another app's link): the same, still never in the route
  const t = memSecrets();
  expect(await go(`roadwise://dashpal#d=${CAM}&k=${ONCE}`, t)).toBe(`/dashpal?d=${CAM}`);
  expect((await t.secrets.readPendingCode(1000))?.code).toBe(ONCE);
  // typed in any case and with dashes, the stored code is the canonical text
  const u = memSecrets();
  await go(`https://${DOMAIN}/dashpal?d=${CAM}&k=${formatCode(Uint8Array.from({ length: 16 }, (_, i) => i), 'label').toLowerCase()}`, u);
  expect((await u.secrets.readPendingCode(1000))?.code).toBe(CODE);
});

test('a code that cannot be kept is dropped (the route still opens setup); a bad d or k opens the code step and keeps nothing', async () => {
  const s = memSecrets({ failWrites: true });
  expect(await go(`https://${DOMAIN}/dashpal#d=${CAM}&k=${CODE}`, s)).toBe(`/dashpal?d=${CAM}`);
  expect(s.store.size).toBe(0);
  for (const bad of [`https://${DOMAIN}/dashpal#d=${CAM}&k=${CODE.slice(0, 27)}`, `https://${DOMAIN}/dashpal#d=xyz&k=${CODE}`, `roadwise://dashpal?d=${CAM}&k=NOTACODE`]) {
    const t = memSecrets();
    expect(await go(bad, t)).toBe('/dashpal');
    expect(t.store.size).toBe(0);
  }
});

test('with no link domain in this build, an https DashPal link is not ours (the app’s own scheme still is)', async () => {
  const s = memSecrets();
  expect(await redirectSystemPath({ path: `https://${DOMAIN}/dashpal#d=${CAM}&k=${CODE}`, initial: true }, { domain: '', secrets: s.secrets })).toBe('/');
  expect(await redirectSystemPath({ path: `roadwise://dashpal?d=${CAM}`, initial: true }, { domain: '', secrets: s.secrets })).toBe(`/dashpal?d=${CAM}`);
});

test('the dev client launcher links pass untouched', async () => {
  expect(await go('exp+roadwise://expo-development-client/?url=x')).toBe('exp+roadwise://expo-development-client/?url=x');
});
