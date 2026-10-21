import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { memoryDb as createTestDb } from '@/features/permissions/__fixtures__/harness';
import { TERMS_VERSION } from '@/features/auth/legal';

import { finishOnboarding, type FinishDeps } from '../finish';
import { ONBOARDING_PENDING_HREF_KEY, ONBOARDING_PLAN_KEY, ONBOARDING_STEP_KEY } from '../state';

// Nothing here may touch the network.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

let settings: SettingsRepo;

beforeEach(async () => {
  settings = createSettingsRepo(await createTestDb());
  await settings.set(ONBOARDING_STEP_KEY, 'dashcam');
  await settings.set(ONBOARDING_PLAN_KEY, ['location', 'dashcam']);
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
    },
    refreshProfile: jest.fn(async () => {
      log.push('refresh');
    }),
    complete: jest.fn(async (version: string) => {
      log.push(`complete:${version}`);
    }),
    armAutoDrives: jest.fn(async () => {
      log.push('arm');
    }),
    ...over,
  };
  return d;
}

test('completes onboarding with the terms version, refreshes, goes Home, then arms automatic drives', async () => {
  const d = deps();
  await finishOnboarding(d);
  expect(d.log).toEqual([`complete:${TERMS_VERSION}`, 'refresh', 'replace:/(tabs)/home', 'arm']);
  expect(await settings.get(ONBOARDING_STEP_KEY)).toBeNull();
  expect(await settings.get(ONBOARDING_PLAN_KEY)).toBeNull();
});

test('arming automatic drives that fails still finishes; it is tried again at the next foreground', async () => {
  const d = deps({ armAutoDrives: jest.fn(async () => Promise.reject(new Error('native'))) });
  await expect(finishOnboarding(d)).resolves.toBeUndefined();
  expect(await settings.get(ONBOARDING_STEP_KEY)).toBeNull();
});

test('a link held for this account is opened instead of Home, then cleared', async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/drives/t-1' });
  const d = deps();
  await finishOnboarding(d);
  expect(d.log).toContain('replace:/drives/t-1');
  expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
});

test('a link held for another account is never opened', async () => {
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u2', href: '/drives/t-1' });
  const d = deps();
  await finishOnboarding(d);
  expect(d.log).toContain('replace:/(tabs)/home');
  expect(d.log).not.toContain('replace:/drives/t-1');
});

test('a failed call navigates nowhere and clears nothing, so it can be tried again', async () => {
  const d = deps({ complete: jest.fn(async () => Promise.reject(new Error('offline'))) });
  await expect(finishOnboarding(d)).rejects.toThrow('offline');
  expect(d.router.replace).not.toHaveBeenCalled();
  expect(d.armAutoDrives).not.toHaveBeenCalled();
  expect(await settings.get(ONBOARDING_STEP_KEY)).toBe('dashcam');
});

test('no signed-in account: rejects before calling anything', async () => {
  const d = deps({ userId: null });
  await expect(finishOnboarding(d)).rejects.toThrow();
  expect(d.complete).not.toHaveBeenCalled();
});
