import { CAMERA_CONSENT_VERSION, CAMERA_OPT_IN_KEY, cameraEligibility, readCameraOptIn, subscribeCameraOptIn, turnCameraOff, turnCameraOn } from '../optIn';

function memory(seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
  };
}

test.each([
  ['nothing stored', undefined, false],
  ['this uid, this version, on', { uid: 'u1', version: CAMERA_CONSENT_VERSION, on: true }, true],
  ['this uid, off', { uid: 'u1', version: CAMERA_CONSENT_VERSION, on: false }, false],
  ['another uid', { uid: 'u2', version: CAMERA_CONSENT_VERSION, on: true }, false],
  ['an older consent version', { uid: 'u1', version: 'camera-beta-0', on: true }, false],
  ['malformed', 'yes', false],
] as const)('%s → %s', async (_, stored, want) => {
  const s = memory(stored === undefined ? {} : { [CAMERA_OPT_IN_KEY]: stored });
  await expect(readCameraOptIn(s, 'u1')).resolves.toBe(want);
});

test('no uid, or a read that fails: off', async () => {
  await expect(readCameraOptIn(memory({ [CAMERA_OPT_IN_KEY]: { uid: 'u1', version: CAMERA_CONSENT_VERSION, on: true } }), null)).resolves.toBe(false);
  await expect(readCameraOptIn({ get: async () => Promise.reject(new Error('io')) }, 'u1')).resolves.toBe(false);
});

test('on: the consent first; a refused consent stores nothing; every change is announced', async () => {
  const s = memory();
  const heard: number[] = [];
  const off = subscribeCameraOptIn(() => heard.push(1));
  await expect(turnCameraOn({ settings: s, recordConsent: async () => Promise.reject(new Error('offline')) }, 'u1')).rejects.toThrow('offline');
  await expect(readCameraOptIn(s, 'u1')).resolves.toBe(false);
  expect(heard).toEqual([]);
  const record = jest.fn(async () => ({}));
  await turnCameraOn({ settings: s, recordConsent: record }, 'u1');
  expect(record).toHaveBeenCalledWith('u1', { type: 'camera', version: CAMERA_CONSENT_VERSION });
  await expect(readCameraOptIn(s, 'u1')).resolves.toBe(true);
  await turnCameraOff(s, 'u1');
  await expect(readCameraOptIn(s, 'u1')).resolves.toBe(false);
  expect(heard).toEqual([1, 1]);
  off();
});

test('eligibility: adults only, then the flag', () => {
  expect(cameraEligibility('18_plus', true)).toBe('ok');
  expect(cameraEligibility('18_plus', false)).toBe('flag_off');
  for (const band of ['13_17', 'u13', 'unknown', null, undefined]) expect(cameraEligibility(band, true)).toBe('age');
});
