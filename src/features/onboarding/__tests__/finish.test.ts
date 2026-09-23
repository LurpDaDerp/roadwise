import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import { CONSENTS_CACHE_KEY } from '../context';
import { finishOnboarding, ONBOARDING_VERSION, type FinishDeps } from '../finish';
import {
  ONBOARDING_PENDING_HREF_KEY,
  ONBOARDING_PLAN_KEY,
  ONBOARDING_STEP_KEY,
  PENDING_PERMISSION_CONSENTS_KEY,
  PERMISSION_CONSENT_VERSION,
} from '../state';

// `context.ts` reaches the app client through `api.ts`; nothing here may touch the network.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: jest.fn() }));

let db: Db;
let settings: SettingsRepo;

beforeEach(async () => {
  db = await createTestDb();
  settings = createSettingsRepo(db);
  await settings.set(ONBOARDING_STEP_KEY, 'ready');
  await settings.set(ONBOARDING_PLAN_KEY, ['location', 'ready']);
  await settings.set(CONSENTS_CACHE_KEY, { userId: 'u1', rows: [] });
});

function deps(over: Partial<FinishDeps> = {}) {
  const log: string[] = [];
  const d: FinishDeps & { log: string[] } = {
    log,
    settings,
    userId: 'u1',
    router: {
      replace: jest.fn((href: unknown) => {
        log.push(`replace:${String(href)}`);
      }),
      push: jest.fn((href: unknown) => {
        log.push(`push:${String(href)}`);
      }),
    },
    refreshProfile: jest.fn(async () => {
      log.push('refresh');
    }),
    mergeFlags: jest.fn(async (patch: object) => {
      log.push(`merge:${JSON.stringify(patch)}`);
    }),
    recordConsent: jest.fn(async (_uid: string, c: { type: string }) => {
      log.push(`consent:${c.type}`);
    }),
    ...over,
  };
  return d;
}

test('merges onboarded and the onboarding version into flags through the server merge, then goes Home', async () => {
  const d = deps();
  await finishOnboarding(d);
  expect(d.mergeFlags).toHaveBeenCalledWith({ onboarded: true, onboardingVersion: ONBOARDING_VERSION });
  expect(ONBOARDING_VERSION).toBe(1);
  expect(d.router.replace).toHaveBeenCalledWith('/(tabs)/home');
  expect(d.router.push).not.toHaveBeenCalled();
});

test('a held, allowlisted link is opened instead of Home', async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/trips/abc/summary' });
  const d = deps();
  await finishOnboarding(d);
  expect(d.router.replace).toHaveBeenCalledWith('/trips/abc/summary');
});

test("M5 T12 r1: a link held for another account, or a legacy bare string, is not opened, and is removed", async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u2', href: '/inbox' });
  const d = deps();
  await finishOnboarding(d);
  expect(d.router.replace).toHaveBeenCalledWith('/(tabs)/home');

  await settings.set(ONBOARDING_PENDING_HREF_KEY, '/inbox');
  const legacy = deps();
  await finishOnboarding(legacy);
  expect(legacy.router.replace).toHaveBeenCalledWith('/(tabs)/home');
  expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
});

test('a held link that is not allowlisted is ignored', async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/settings/delete-account' });
  const d = deps();
  await finishOnboarding(d);
  expect(d.router.replace).toHaveBeenCalledWith('/(tabs)/home');
});

test('the navigation lands in the same turn as the refreshed profile, so the gate sees both together', async () => {
  // The gate (AuthGate) sends anyone outside onboarding back to it while the profile says setup is
  // owed, and sends anyone inside onboarding Home once it says ready. Navigating before the
  // refresh would be bounced back to onboarding (and the held link re-held, then lost); refreshing
  // and rendering before navigating would send the driver Home. The replace follows the refresh
  // with no await between them.
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/inbox' });
  let replacedInRefreshTurn = false;
  let refreshed = false;
  const d = deps({
    refreshProfile: jest.fn(async () => {
      refreshed = true;
      // React renders the new profile on a later task; the gate's effect runs then.
      setImmediate(() => {
        refreshed = false;
      });
    }),
    router: {
      replace: jest.fn(() => {
        replacedInRefreshTurn = refreshed;
      }),
      push: jest.fn(),
    },
  });
  await finishOnboarding(d);
  expect(d.refreshProfile).toHaveBeenCalled();
  expect(replacedInRefreshTurn).toBe(true);
});

test('order: consents owed, merge, refresh, navigate', async () => {
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u1', types: ['location', 'motion'] });
  const d = deps();
  await finishOnboarding(d);
  expect(d.log).toEqual([
    'consent:location',
    'consent:motion',
    `merge:${JSON.stringify({ onboarded: true, onboardingVersion: 1 })}`,
    'refresh',
    'replace:/(tabs)/home',
  ]);
  expect(d.recordConsent).toHaveBeenCalledWith('u1', { type: 'location', version: PERMISSION_CONSENT_VERSION });
  expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toBeNull();
});

test('a consent owed by another account is never sent under this one', async () => {
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'someone-else', types: ['location'] });
  const d = deps();
  await finishOnboarding(d);
  expect(d.recordConsent).not.toHaveBeenCalled();
});

test('a consent that still fails is kept, and does not stop the finish', async () => {
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u1', types: ['location', 'motion'] });
  const d = deps({
    recordConsent: jest.fn(async (_uid: string, c: { type: string }) => {
      if (c.type === 'location') throw new Error('offline');
    }),
  });
  await finishOnboarding(d);
  expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toEqual({ userId: 'u1', types: ['location'] });
  expect(d.router.replace).toHaveBeenCalledWith('/(tabs)/home');
});

test('the onboarding state, the held link and the consents cache are cleared after the finish', async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/inbox' });
  await finishOnboarding(deps());
  expect(await settings.get(ONBOARDING_STEP_KEY)).toBeNull();
  expect(await settings.get(ONBOARDING_PLAN_KEY)).toBeNull();
  expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  expect(await settings.get(CONSENTS_CACHE_KEY)).toBeNull();
});

test('a failed merge rejects, and nothing is refreshed, navigated or cleared', async () => {
  const d = deps({ mergeFlags: jest.fn(async () => Promise.reject(new Error('offline'))) });
  await expect(finishOnboarding(d)).rejects.toThrow('offline');
  expect(d.refreshProfile).not.toHaveBeenCalled();
  expect(d.router.replace).not.toHaveBeenCalled();
  expect(await settings.get(ONBOARDING_STEP_KEY)).toBe('ready');
});

test('a failed refresh rejects without navigating: the gate would bounce a stale profile back', async () => {
  const d = deps({ refreshProfile: jest.fn(async () => Promise.reject(new Error('timeout'))) });
  await expect(finishOnboarding(d)).rejects.toThrow('timeout');
  expect(d.router.replace).not.toHaveBeenCalled();
  expect(await settings.get(ONBOARDING_STEP_KEY)).toBe('ready');
});

test('no session: nothing is written', async () => {
  const d = deps({ userId: null });
  await expect(finishOnboarding(d)).rejects.toThrow();
  expect(d.mergeFlags).not.toHaveBeenCalled();
  expect(d.router.replace).not.toHaveBeenCalled();
});

test('"Start a drive now" lands Home with the drive start over it, whatever link was held', async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/inbox' });
  const d = deps();
  await finishOnboarding(d, { startDrive: true });
  expect(d.log.slice(-2)).toEqual(['replace:/(tabs)/home', 'push:/drive/start']);
});
