import { assessHealth, type HealthContext, type PermissionSnapshot } from '@/core/permissions';
import { CONFIG_DEFAULTS } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { parseDisclosureReason } from '@/features/permissions/BackgroundDisclosure';
import { guideFor, vendorOf } from '@/features/permissions/oemGuides';
import { bannerMessage } from '@/features/permissions/PermissionHealthBanner';
import { readinessMessage } from '@/features/permissions/PermissionHealthScreen';
import { offerDue, type OfferInput } from '@/features/permissions/PermissionPromptsHost';
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
      message: 'Drive recording is off — tap to fix',
      tone: 'danger',
    });
  });
  test('approximate location, or Always lost while auto-record is wanted: location is limited', () => {
    expect(banner({ precise: false })?.message).toBe('Location access is limited — tap to fix');
    expect(banner({ location: 'foreground' }, { everGranted: { locationAlways: true } })?.message).toBe(
      'Location access is limited — tap to fix'
    );
  });
  test('motion lost: manual-mode wording for a manual driver, auto-record wording otherwise', () => {
    expect(banner({ motion: 'denied', location: 'foreground' }, { manualByChoice: true, everGranted: { motion: true } })?.message).toBe(
      'Motion access is off, so drives may not end on their own — tap to fix'
    );
    expect(banner({ motion: 'denied' }, { everGranted: { motion: true } })?.message).toBe(
      'Motion access is off, so auto-record can’t start drives and drives may not end on their own — tap to fix'
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

describe('Run a test says exactly what readiness found', () => {
  test('armed only when armed', () => {
    expect(readinessMessage({ allowed: true, armed: true })).toBe('Auto-record is armed on this phone right now.');
  });
  test('allowed but not armed', () => {
    expect(readinessMessage({ allowed: true, armed: false })).toBe(
      'Auto-record isn’t armed right now, though this phone allows it.'
    );
  });
  test('not allowed', () => {
    expect(readinessMessage({ allowed: false, armed: false })).toMatch(/^Auto-record isn’t armed\. This phone doesn’t allow it yet/);
  });
  test("couldn't check when readiness cannot say", () => {
    expect(readinessMessage({ allowed: false, armed: null })).toBe('We couldn’t check auto-record on this phone.');
  });
  test('never a detection promise', () => {
    for (const r of [
      { allowed: true, armed: true },
      { allowed: true, armed: false },
      { allowed: false, armed: false },
      { allowed: false, armed: null },
    ]) {
      expect(readinessMessage(r)).not.toMatch(/will be detected|detects your drives|drives will/i);
    }
  });
});

describe('the post-drive offers', () => {
  const offer = (over: Partial<OfferInput> = {}) =>
    offerDue({
      platform: 'ios',
      driver: true,
      autoDetectAvailable: true,
      completedDrives: 1,
      offers: {},
      manualByChoice: false,
      canPromptAlways: true,
      location: 'foreground',
      ...over,
    });

  test.each([
    ['iOS after the first drive', {}, 'first-drive'],
    ['iOS before any drive', { completedDrives: 0 }, null],
    ['iOS first offer made, second drive', { completedDrives: 2, offers: { 'first-drive': 1 } }, null],
    ['iOS third drive, once more', { completedDrives: 3, offers: { 'first-drive': 1 } }, 'third-drive'],
    ['iOS both made', { completedDrives: 7, offers: { 'first-drive': 1, 'third-drive': 2 } }, null],
    ['Android first drive: none (A6 asked)', { platform: 'android' as const }, null],
    ['Android third drive', { platform: 'android' as const, completedDrives: 3 }, 'third-drive'],
    ['Android third offer made', { platform: 'android' as const, completedDrives: 5, offers: { 'third-drive': 1 } }, null],
    ['manual by choice', { completedDrives: 3, manualByChoice: true }, null],
    ['inside the 14-day window', { completedDrives: 3, canPromptAlways: false }, null],
    ['already Always', { location: 'always' as const }, null],
    ['location denied', { location: 'denied' as const }, null],
    ['location not read yet (cheap pre-check)', { location: null }, 'first-drive'],
    ['non-driver', { driver: false }, null],
    ['auto-record withdrawn by the server', { autoDetectAvailable: false }, null],
  ] as const)('%s', (_name, over, expected) => {
    expect(offer(over)).toBe(expected);
  });
});

test('completed drives count the driver’s own trips only', () => {
  expect(completedDrives([{ role: 'driver' }, { role: 'unknown' }, { role: 'passenger' }, { role: 'other' }])).toBe(2);
  expect(completedDrives([])).toBe(0);
});

describe('OEM battery guides', () => {
  const guides = CONFIG_DEFAULTS.oem_battery_guides;
  test.each([
    ['samsung', 'samsung'],
    ['Samsung', 'samsung'],
    ['Xiaomi', 'xiaomi'],
    ['Redmi', 'xiaomi'],
    ['POCO', 'xiaomi'],
    ['OnePlus', 'oneplus'],
    ['Google', 'google'],
    ['motorola', null],
    ['', null],
    [null, null],
  ] as const)('%s → %s', (maker, vendor) => {
    expect(vendorOf(maker)).toBe(vendor);
    expect(guideFor(maker, guides)).toBe(vendor ? guides[vendor] : guides.default);
  });
  test('a vendor with no guide in config falls back to the general guide', () => {
    expect(guideFor('Samsung', { default: guides.default })).toBe(guides.default);
  });
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
  test('records the disclosure version; an offline failure is kept and sent later', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const record = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    expect(await recordDisclosureConsent(settings, 'u1', record)).toBe(false);
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBe('pd-1');
    await flushPendingDisclosureConsent(settings, 'u1', record);
    expect(record).toHaveBeenLastCalledWith('u1', { type: 'background_location', version: 'pd-1' });
    expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBeNull();
    await flushPendingDisclosureConsent(settings, 'u1', record);
    expect(record).toHaveBeenCalledTimes(2);
  });
});

test('route reasons: known values pass; anything else is a repair', () => {
  expect(parseDisclosureReason('first-drive')).toBe('first-drive');
  expect(parseDisclosureReason(['third-drive'])).toBe('third-drive');
  expect(parseDisclosureReason('onboarding')).toBe('onboarding');
  expect(parseDisclosureReason('nonsense')).toBe('repair');
  expect(parseDisclosureReason(undefined)).toBe('repair');
});
