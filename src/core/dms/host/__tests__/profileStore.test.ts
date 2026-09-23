// The profile store (plan Privacy 7, rev1 S-M2): the settings table, one key, bound to the uid. A uid
// mismatch never loads and removes the key; the handover wipe and the u13 purge clear it by construction.
import { DEVICE_TABLES } from '@/boot/device';
import { KEPT_SETTINGS } from '@/features/onboarding/api';
import type { DmsProfileV1 } from '../../engine/profile';
import { createSettingsProfileStore, DMS_PROFILE_KEY } from '../profileStore';

// jest hoists these above the imports: onboarding/api reaches for the Supabase client.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/profile', () => ({ updateOwnProfile: jest.fn(), recordConsent: jest.fn() }));
jest.mock('@/features/drive/summaryNotifier', () => ({ cancelDriveSummaries: jest.fn() }));

const PROFILE: DmsProfileV1 = {
  v: 1,
  driverSide: 'left',
  orientation: 90,
  mount: { yawDeg: -10, pitchDeg: 5, rollDeg: 0, boxCx: 0.5, boxCy: 0.45, iod: 0.2 },
  gazeCentres: { geometric: { yaw: 2, pitch: -3 } },
  headCentre: { yaw: 1, pitch: -1 },
  rollOffsetDeg: 0,
  radiusDeg: 9,
  openEyeEar: [0.3, 0.3],
  neutralMar: 0.08,
  neutralMouthW: 0.9,
  learnedZones: [],
  savedAtMs: 1_760_000_000_000,
};

function memorySettings(initial: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(initial));
  return {
    map: m,
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    remove: async (k: string) => m.delete(k),
  };
}

test('the key is dms.profile; save stores { uid, profile }; load returns it for the same uid', async () => {
  const s = memorySettings();
  const store = createSettingsProfileStore(s, 'uid-a');
  await store.save(PROFILE);
  expect(DMS_PROFILE_KEY).toBe('dms.profile');
  expect(s.map.get('dms.profile')).toEqual({ uid: 'uid-a', profile: PROFILE });
  expect(await store.load()).toEqual(PROFILE);
});

test('a uid mismatch returns null and removes the key (uid A’s profile never loads for uid B)', async () => {
  const s = memorySettings({ 'dms.profile': { uid: 'uid-a', profile: PROFILE } });
  expect(await createSettingsProfileStore(s, 'uid-b').load()).toBeNull();
  expect(s.map.has('dms.profile')).toBe(false);
});

test('a malformed stored value or profile is ignored (null), and removed', async () => {
  const bad = memorySettings({ 'dms.profile': { uid: 'uid-a', profile: { v: 2 } } });
  expect(await createSettingsProfileStore(bad, 'uid-a').load()).toBeNull();
  expect(bad.map.has('dms.profile')).toBe(false);
  const junk = memorySettings({ 'dms.profile': 'junk' });
  expect(await createSettingsProfileStore(junk, 'uid-a').load()).toBeNull();
});

test('clear removes it', async () => {
  const s = memorySettings({ 'dms.profile': { uid: 'uid-a', profile: PROFILE } });
  await createSettingsProfileStore(s, 'uid-a').clear();
  expect(s.map.has('dms.profile')).toBe(false);
});

test('wiped by construction: DEVICE_TABLES includes settings; KEPT_SETTINGS excludes dms.profile', () => {
  expect(DEVICE_TABLES).toContain('settings');
  expect(KEPT_SETTINGS).not.toContain(DMS_PROFILE_KEY);
});
