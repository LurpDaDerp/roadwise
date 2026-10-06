/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate } from '@/data/db';
import { readPushToken, type PushPort } from '@/data/devices/pushToken';
import { LAST_REGISTER_KEY, LEAGUE_ELIGIBLE_KEY, readLeagueEligible, REGISTER_INTERVAL_MS, registerDevice, registeredRecently, releaseDevice } from '@/data/devices/register';

const T0 = 1_700_000_000_000;

test('register_device is called with the install id, platform and token; league_eligible is cached; repeats are throttled', async () => {
  const db = await createSqlJsDb();
  await migrate(db);
  const settings = createSettingsRepo(db);
  const calls: unknown[] = [];
  const rpc = async (fn: string, args?: Record<string, unknown>) => {
    calls.push([fn, args]);
    return { league_eligible: true };
  };
  const base = { rpc, settings, userId: 'u1', deviceId: 'install-1234', platform: 'ios' as const, pushToken: 'ExponentPushToken[abcdefgh12345678]', now: () => T0 };
  expect(await registerDevice(base)).toBe('saved');
  expect(calls).toEqual([['register_device', { p_device_id: 'install-1234', p_platform: 'ios', p_push_token: 'ExponentPushToken[abcdefgh12345678]' }]]);
  expect(await readLeagueEligible(settings, 'u1')).toBe(true);
  expect(await readLeagueEligible(settings, 'u2')).toBeNull();
  expect(await registerDevice({ ...base, now: () => T0 + 1000 })).toBe('throttled');
  expect(await registerDevice({ ...base, pushToken: null, now: () => T0 + 1000 })).toBe('saved'); // the token changed
  expect(calls[1]).toEqual(['register_device', { p_device_id: 'install-1234', p_platform: 'ios' }]);
  expect(await registerDevice({ ...base, pushToken: null, now: () => T0 + 2000 })).toBe('throttled');
  expect(await registerDevice({ ...base, pushToken: null, now: () => T0 + 1000 + REGISTER_INTERVAL_MS })).toBe('saved');
  expect(await registerDevice({ ...base, pushToken: null, now: () => T0 + 1001 + REGISTER_INTERVAL_MS, force: true })).toBe('saved');
  const failing = { ...base, rpc: async () => Promise.reject(new Error('offline')), onError: jest.fn() };
  expect(await registerDevice({ ...failing, now: () => T0 + 2 * REGISTER_INTERVAL_MS })).toBe('error');
  expect(failing.onError).toHaveBeenCalled();
  expect(await settings.get(LEAGUE_ELIGIBLE_KEY)).toEqual({ userId: 'u1', eligible: true });
});

test('registeredRecently: true only for this account and install within 6 hours (checked before reading the push token)', async () => {
  const db = await createSqlJsDb();
  await migrate(db);
  const settings = createSettingsRepo(db);
  expect(await registeredRecently(settings, 'u1', 'install-1234', T0)).toBe(false);
  await settings.set(LAST_REGISTER_KEY, { userId: 'u1', deviceId: 'install-1234', at: T0, token: 'ExponentPushToken[x]' });
  expect(await registeredRecently(settings, 'u1', 'install-1234', T0 + 1000)).toBe(true);
  expect(await registeredRecently(settings, 'u2', 'install-1234', T0 + 1000)).toBe(false);
  expect(await registeredRecently(settings, 'u1', 'install-9999', T0 + 1000)).toBe(false);
  expect(await registeredRecently(settings, 'u1', 'install-1234', T0 + REGISTER_INTERVAL_MS)).toBe(false);
  expect(await registeredRecently(settings, 'u1', 'install-1234', T0 - 1)).toBe(false);
});

test('releaseDevice calls release_device within its budget, clears the local stamp, and tolerates failure', async () => {
  const db = await createSqlJsDb();
  await migrate(db);
  const settings = createSettingsRepo(db);
  await settings.set(LAST_REGISTER_KEY, { userId: 'u1', deviceId: 'install-1234', at: T0, token: null });
  const calls: unknown[] = [];
  expect(await releaseDevice({ rpc: async (fn, args) => void calls.push([fn, args]), settings, deviceId: 'install-1234' })).toBe('released');
  expect(calls).toEqual([['release_device', { p_device_id: 'install-1234' }]]);
  expect(await settings.get(LAST_REGISTER_KEY)).toBeNull();
  expect(await releaseDevice({ rpc: async () => Promise.reject(new Error('offline')), settings, deviceId: 'install-1234' })).toBe('failed');
  expect(await releaseDevice({ rpc: async () => null, settings, deviceId: null })).toBe('skipped');
  jest.useFakeTimers();
  try {
    const hung = releaseDevice({ rpc: () => new Promise(() => {}), settings, deviceId: 'install-1234', budgetMs: 100 });
    await jest.advanceTimersByTimeAsync(150);
    expect(await hung).toBe('failed');
  } finally {
    jest.useRealTimers();
  }
});

test('readPushToken: only on a device with permission, and only a real Expo token', async () => {
  const port = (over: Partial<PushPort>): PushPort => ({
    isDevice: () => true,
    permitted: async () => true,
    getExpoPushToken: async () => 'ExponentPushToken[abcdefgh12345678]',
    addPushTokenListener: () => ({ remove() {} }),
    ...over,
  });
  expect(await readPushToken(port({}), null)).toBe('ExponentPushToken[abcdefgh12345678]');
  expect(await readPushToken(port({ isDevice: () => false }), null)).toBeNull();
  expect(await readPushToken(port({ permitted: async () => false }), null)).toBeNull();
  expect(await readPushToken(port({ getExpoPushToken: async () => 'junk' }), null)).toBeNull();
  const errors: unknown[] = [];
  expect(await readPushToken(port({ getExpoPushToken: async () => Promise.reject(new Error('x')) }), null, (e) => errors.push(e))).toBeNull();
  expect(errors).toHaveLength(1);
});
