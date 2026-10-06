import { assessHealth, type HealthContext, type PermissionSnapshot } from '@/core/permissions';
import { CONFIG_DEFAULTS } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { bannerMessage } from '@/features/permissions/PermissionHealthBanner';
import {
  completedDrives,
  flushPendingDisclosureConsent,
  markSettingsReturn,
  PENDING_DISCLOSURE_CONSENT_KEY,
  recordDisclosureConsent,
  SETTINGS_RETURN_ACK_MS,
  takeSettingsReturnAck,
} from '@/features/permissions/usePermissionHealth';

jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));
jest.mock('@/data/supabase/session', () => ({ useSession: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: jest.fn(), useSegments: jest.fn(), useFocusEffect: jest.fn() }));

const base: PermissionSnapshot = {
  platform: 'android',
  location: 'always',
  precise: true,
  locationCanAskAgain: true,
  motion: 'granted',
  notifications: 'granted',
  notificationsCanAskAgain: true,
  batteryOptimization: 'exempt',
  lowPowerMode: false,
  checkedAt: 0,
};
const ctx: HealthContext = {
  drives: true,
  autoDetectOn: true,
  autoDetectAvailable: true,
  firstDriveDone: true,
  manualByChoice: false,
  everGranted: {},
};
const banner = (s: Partial<PermissionSnapshot>, c: Partial<HealthContext> = {}) => {
  const snapshot = { ...base, ...s };
  const context = { ...ctx, ...c };
  return bannerMessage(snapshot, assessHealth(snapshot, context), context);
};

describe('the Home banner', () => {
  test('location off: drive recording is off', () => {
    expect(banner({ location: 'denied' })).toEqual({
      message: 'Drive recording is off. Tap to fix.',
      tone: 'danger',
    });
  });
  test('approximate location, or Always lost while auto-record is wanted: location is limited', () => {
    expect(banner({ precise: false })?.message).toBe('Location access is limited. Tap to fix.');
    expect(banner({ location: 'foreground' }, { everGranted: { locationAlways: true } })?.message).toBe(
      'Location access is limited. Tap to fix.'
    );
  });
  test('motion lost: manual-mode wording for a manual driver, auto-record wording otherwise', () => {
    expect(banner({ motion: 'denied', location: 'foreground' }, { manualByChoice: true, everGranted: { motion: true } })?.message).toBe(
      'Motion access is off, so drives may not end on their own. Tap to fix.'
    );
    expect(banner({ motion: 'denied' }, { everGranted: { motion: true } })?.message).toBe(
      'Motion access is off, so auto-record can’t start drives and drives may not end on their own. Tap to fix.'
    );
  });
  test('hidden for a deliberate manual mode, for iOS before the first drive, for a withdrawn flag, for a non-driver', () => {
    const lapse = { everGranted: { locationAlways: true } };
    expect(banner({ location: 'foreground' }, { ...lapse, manualByChoice: true })).toBeNull();
    expect(banner({ location: 'foreground' }, { ...lapse, autoDetectOn: false })).toBeNull();
    expect(banner({ platform: 'ios', location: 'foreground' }, { ...lapse, firstDriveDone: false })).toBeNull();
    expect(banner({ location: 'foreground' }, { ...lapse, autoDetectAvailable: false })).toBeNull();
    expect(banner({ location: 'denied' }, { drives: false })).toBeNull();
    // Negative control: the same lapse with nothing excusing it shows.
    expect(banner({ location: 'foreground' }, lapse)).not.toBeNull();
  });
  test('all good: no banner', () => {
    expect(banner({})).toBeNull();
  });
});

test('completed drives count the driver’s own trips only', () => {
  expect(completedDrives([{ role: 'driver' }, { role: 'unknown' }, { role: 'passenger' }, { role: 'other' }])).toBe(2);
  expect(completedDrives([])).toBe(0);
});

describe('the Settings-return acknowledgement', () => {
  test('taken once, within 30 minutes of a trip to Settings from B2', async () => {
    const settings = createSettingsRepo(await createTestDb());
    expect(await takeSettingsReturnAck(settings, 1_000)).toBe(false);
    await markSettingsReturn(settings, 1_000);
    expect(await takeSettingsReturnAck(settings, 1_000 + SETTINGS_RETURN_ACK_MS)).toBe(true);
    expect(await takeSettingsReturnAck(settings, 1_000 + SETTINGS_RETURN_ACK_MS)).toBe(false);
  });
  test('stale, or from a clock that moved back: not an ack, and cleared', async () => {
    const settings = createSettingsRepo(await createTestDb());
    await markSettingsReturn(settings, 1_000);
    expect(await takeSettingsReturnAck(settings, 1_001 + SETTINGS_RETURN_ACK_MS)).toBe(false);
    await markSettingsReturn(settings, 5_000);
    expect(await takeSettingsReturnAck(settings, 4_000)).toBe(false);
    expect(await settings.get('permissions.settingsReturnAck')).toBeNull();
  });
});

describe('the background-location consent', () => {
  const signedIn = (uid: string) => ({ shownTo: uid, sessionUid: uid });

  test('recorded at once under the signed-in account', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn(async () => ({}));
    expect(await recordDisclosureConsent(settings, signedIn('u1'), record)).toBe(true);
    expect(record).toHaveBeenCalledWith('u1', { type: 'background_location', version: 'pd-2' });
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBeNull();
  });

  test('an offline failure is kept bound to its account and sent later under it', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    expect(await recordDisclosureConsent(settings, signedIn('u1'), record)).toBe(false);
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toEqual({ version: 'pd-2', userId: 'u1' });
    await flushPendingDisclosureConsent(settings, 'u1', record);
    expect(record).toHaveBeenLastCalledWith('u1', { type: 'background_location', version: 'pd-2' });
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBeNull();
    await flushPendingDisclosureConsent(settings, 'u1', record);
    expect(record).toHaveBeenCalledTimes(2);
  });

  test('security M-1: never sent under another account (left for the handover wipe)', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    await recordDisclosureConsent(settings, signedIn('driver-a'), record);
    record.mockClear();
    await flushPendingDisclosureConsent(settings, 'driver-b', record);
    expect(record).not.toHaveBeenCalled();
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toEqual({ version: 'pd-2', userId: 'driver-a' });
    // Negative control: under its own account it goes.
    await flushPendingDisclosureConsent(settings, 'driver-a', record);
    expect(record).toHaveBeenCalledWith('driver-a', { type: 'background_location', version: 'pd-2' });
  });

  test('session lost mid-flow: kept bound to the account shown the disclosure, never sent now', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn(async () => ({}));
    expect(await recordDisclosureConsent(settings, { shownTo: 'u1', sessionUid: null }, record)).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toEqual({ version: 'pd-2', userId: 'u1' });
    await flushPendingDisclosureConsent(settings, 'someone-else', record);
    expect(record).not.toHaveBeenCalled();
    await flushPendingDisclosureConsent(settings, 'u1', record);
    expect(record).toHaveBeenCalledWith('u1', { type: 'background_location', version: 'pd-2' });
  });

  test('security r1-M1: shown to nobody known — nothing recorded or kept, whoever is signed in', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn(async () => ({}));
    expect(await recordDisclosureConsent(settings, { shownTo: null, sessionUid: 'u1' }, record)).toBe(false);
    expect(await recordDisclosureConsent(settings, { shownTo: null, sessionUid: null }, record)).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBeNull();
  });

  test('security r1-M1: a different account signed in at the grant — nothing recorded or kept', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn(async () => ({}));
    expect(await recordDisclosureConsent(settings, { shownTo: 'driver-a', sessionUid: 'driver-b' }, record)).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBeNull();
  });

  test('an unbound (malformed) pending record is removed, never sent', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn(async () => ({}));
    await settings.set(PENDING_DISCLOSURE_CONSENT_KEY, 'pd-1');
    await flushPendingDisclosureConsent(settings, 'u1', record);
    expect(record).not.toHaveBeenCalled();
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBeNull();
  });
});

