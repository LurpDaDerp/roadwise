import { EVER_GRANTED_KEY, type PermissionSnapshot, type ServerPermissions } from '@/core/permissions';
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { createSettingsRepo, type Db } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { SETTINGS_RETURN_ACK_KEY } from '@/features/permissions/usePermissionHealth';
import { LOCAL_SENT_KEY } from '@/notifications/keys';

import { createFakeSupabase, type FakeSupabase } from '../__fixtures__/fakeSupabase';
import { INSTALL_ID_KEY } from '../installId';
import {
  createBackgroundPermissionReporter,
  REPORTED_PERMISSIONS_KEY,
  reportPermissions,
  reportPermissionsFromBackground,
} from '../permissionsReport';
import { LAST_UPSERT_KEY } from '../register';

// usePermissionHealth (T9's Settings-return mark) sits beside the app client; neither is used here.
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));
jest.mock('@/data/supabase/session', () => ({ useSession: jest.fn() }));

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);

const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  platform: 'ios',
  location: 'always',
  precise: true,
  locationCanAskAgain: false,
  motion: 'granted',
  notifications: 'granted',
  notificationsCanAskAgain: false,
  batteryOptimization: 'exempt',
  lowPowerMode: false,
  checkedAt: T0,
  ...over,
});

let db: Db;
let fake: FakeSupabase;
let now: number;
const settings = () => createSettingsRepo(db);
const deps = () => ({ supabase: fake.client, settings: settings(), now: () => now });
const input = (snapshot: PermissionSnapshot, over: Partial<Parameters<typeof reportPermissions>[0]> = {}) => ({
  userId: 'user-a',
  deviceId: 'install-1',
  snapshot,
  reportedFrom: 'foreground' as const,
  ack: false,
  ...over,
});
const written = (): ServerPermissions[] =>
  fake.to('devices').map((c) => (c.values as { permissions: ServerPermissions }).permissions);

beforeEach(async () => {
  db = await createTestDb();
  fake = createFakeSupabase();
  now = T0;
});

describe('reportPermissions', () => {
  it('reports the server shape for this device, then only when a permission changes', async () => {
    expect(await reportPermissions(input(snap()), deps())).toBe('reported');
    const [call] = fake.to('devices');
    expect(call?.op).toBe('update');
    expect(call?.filters).toEqual([
      ['user_id', 'user-a'],
      ['id', 'install-1'],
    ]);
    expect(Object.keys(call?.values as object).sort()).toEqual(['last_seen_at', 'permissions']);
    expect(written()[0]).toMatchObject({ v: 1, location: 'always', motion: 'granted', reportedFrom: 'foreground', ack: false });

    now += 60_000;
    expect(await reportPermissions(input(snap({ checkedAt: now, lowPowerMode: true })), deps())).toBe('unchanged');
    expect(fake.to('devices')).toHaveLength(1);

    expect(await reportPermissions(input(snap({ location: 'foreground' })), deps())).toBe('reported');
    expect(written()[1]?.location).toBe('foreground');
  });

  it('carries ack and reportedFrom', async () => {
    await reportPermissions(input(snap()), deps());
    await reportPermissions(
      input(snap({ location: 'foreground' }), { reportedFrom: 'background', ack: true }),
      deps()
    );
    expect(written()[1]).toMatchObject({ reportedFrom: 'background', ack: true });
  });

  it('updates everGranted, even when nothing is sent', async () => {
    await reportPermissions(input(snap({ location: 'foreground', motion: 'denied' })), deps());
    expect(await settings().get(EVER_GRANTED_KEY)).toEqual({ location: true });
    fake.respond = () => ({ data: null, error: { message: 'offline' } });
    await reportPermissions(input(snap()), deps());
    expect(await settings().get(EVER_GRANTED_KEY)).toEqual({ location: true, locationAlways: true, motion: true });
  });

  it('motion that cannot be checked never erases the stored motion (the lapse baseline)', async () => {
    await reportPermissions(input(snap({ motion: 'granted' })), deps());
    // the only change is motion becoming unknown: nothing to send
    expect(await reportPermissions(input(snap({ motion: null })), deps())).toBe('unchanged');
    // another change while motion is unknown: the last reported motion is kept in the object
    expect(await reportPermissions(input(snap({ motion: null, location: 'foreground' })), deps())).toBe('reported');
    expect(written()[1]).toMatchObject({ location: 'foreground', motion: 'granted' });
    // and a later real lapse is still a granted -> denied transition on the server
    await reportPermissions(input(snap({ motion: 'denied', location: 'foreground' })), deps());
    expect(written()[2]?.motion).toBe('denied');
  });

  it('motion unknown with nothing reported before: the key is left out (unknown, never a lapse)', async () => {
    await reportPermissions(input(snap({ motion: null })), deps());
    expect(written()[0]).not.toHaveProperty('motion');
  });

  it('a failed write records nothing, so the next report sends it', async () => {
    fake.respond = () => ({ data: null, error: { message: 'offline' } });
    expect(await reportPermissions(input(snap()), deps())).toBe('error');
    expect(await settings().get(REPORTED_PERMISSIONS_KEY)).toBeNull();
    fake.respond = () => ({ data: [{ id: 'install-1' }], error: null });
    expect(await reportPermissions(input(snap()), deps())).toBe('reported');
  });

  it('no device row yet: nothing matched, nothing recorded', async () => {
    fake.respond = () => ({ data: [], error: null });
    expect(await reportPermissions(input(snap()), deps())).toBe('no-device');
    expect(await settings().get(REPORTED_PERMISSIONS_KEY)).toBeNull();
  });

  it('another account or install id is compared against its own report', async () => {
    await reportPermissions(input(snap()), deps());
    expect(await reportPermissions(input(snap(), { userId: 'user-b' }), deps())).toBe('reported');
    expect(await reportPermissions(input(snap(), { userId: 'user-b', deviceId: 'install-2' }), deps())).toBe(
      'reported'
    );
  });

  describe("ack: 'settingsReturn' (T9's mark from B2's Open Settings)", () => {
    it('takes the mark only when a report is written, and sends ack: true', async () => {
      await reportPermissions(input(snap()), deps());
      await settings().set(SETTINGS_RETURN_ACK_KEY, now - 1_000);
      expect(await reportPermissions(input(snap(), { ack: 'settingsReturn' }), deps())).toBe('unchanged');
      expect(await settings().get(SETTINGS_RETURN_ACK_KEY)).not.toBeNull();
      await reportPermissions(input(snap({ location: 'foreground' }), { ack: 'settingsReturn' }), deps());
      expect(written()[1]?.ack).toBe(true);
      expect(await settings().get(SETTINGS_RETURN_ACK_KEY)).toBeNull();
    });

    it('no mark: ack false', async () => {
      await reportPermissions(input(snap(), { ack: 'settingsReturn' }), deps());
      expect(written()[0]?.ack).toBe(false);
    });

    it('a failed write puts the mark back, so the retry still carries the ack', async () => {
      await reportPermissions(input(snap()), deps());
      await settings().set(SETTINGS_RETURN_ACK_KEY, now - 1_000);
      fake.respond = () => ({ data: null, error: { message: 'offline' } });
      await reportPermissions(input(snap({ location: 'foreground' }), { ack: 'settingsReturn' }), deps());
      fake.respond = () => ({ data: [{ id: 'install-1' }], error: null });
      await reportPermissions(input(snap({ location: 'foreground' }), { ack: 'settingsReturn' }), deps());
      expect(written()[2]?.ack).toBe(true);
    });
  });
});

describe('reportPermissionsFromBackground', () => {
  async function seedDevice(owner = 'user-a') {
    const s = settings();
    await s.set(LAST_USER_KEY, owner);
    await s.set(INSTALL_ID_KEY, 'install-1');
    await s.set(LAST_UPSERT_KEY, { userId: owner, deviceId: 'install-1', at: T0, appVersion: '2.0.0', fingerprint: null });
  }
  const bg = (snapshot: PermissionSnapshot | (() => Promise<PermissionSnapshot>)) =>
    reportPermissionsFromBackground({
      db,
      supabase: fake.client,
      now: () => now,
      adapter: { snapshot: typeof snapshot === 'function' ? snapshot : async () => snapshot },
    });

  it('reports a change as reportedFrom background, with the day count written first (N-I1)', async () => {
    await seedDevice();
    await reportPermissions(input(snap()), deps());
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 2 });
    expect(await bg(snap({ location: 'foreground' }))).toBe('reported');
    const order = fake.calls.map((c) => `${c.target}:${c.op}`);
    expect(order.slice(1)).toEqual(['notification_prefs:update', 'devices:update']);
    expect(fake.to('notification_prefs')[0]?.values).toEqual({ local_sent_day: '2026-09-22', local_sent_count: 2 });
    expect(written()[1]).toMatchObject({ location: 'foreground', reportedFrom: 'background', ack: false });
  });

  it('inserts the count row when the account has none yet', async () => {
    await seedDevice();
    await reportPermissions(input(snap()), deps());
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 1 });
    fake.respond = (c) =>
      c.target === 'notification_prefs' && c.op === 'update'
        ? { data: [], error: null }
        : { data: c.columns ? [{ id: 'x' }] : null, error: null };
    await bg(snap({ location: 'foreground' }));
    expect(fake.to('notification_prefs').map((c) => c.op)).toEqual(['update', 'insert']);
    expect(fake.to('notification_prefs')[1]?.values).toEqual({
      user_id: 'user-a',
      local_sent_day: '2026-09-22',
      local_sent_count: 1,
    });
  });

  it('a count that fails to send does not hold back the lapse report', async () => {
    await seedDevice();
    await reportPermissions(input(snap()), deps());
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 1 });
    fake.respond = (c) =>
      c.target === 'notification_prefs'
        ? { data: null, error: { message: 'nope' } }
        : { data: [{ id: 'x' }], error: null };
    expect(await bg(snap({ location: 'foreground' }))).toBe('reported');
  });

  it('no change: no network at all (no session read, no request)', async () => {
    await seedDevice();
    await reportPermissions(input(snap()), deps());
    const getSession = jest.spyOn(fake.client.auth, 'getSession');
    const before = fake.calls.length;
    expect(await bg(snap({ checkedAt: T0 + 5_000 }))).toBe('unchanged');
    expect(fake.calls.length).toBe(before);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('a snapshot that fails reports nothing (never a made-up state)', async () => {
    await seedDevice();
    expect(
      await bg(async () => {
        throw new Error('location read failed');
      })
    ).toBe('skipped');
    expect(fake.calls).toHaveLength(0);
  });

  it('skipped with no owner, a pending handover, no install id or no registered device', async () => {
    expect(await bg(snap())).toBe('skipped');
    await seedDevice();
    await settings().set(PENDING_OWNER_KEY, 'user-b');
    expect(await bg(snap())).toBe('skipped');
    await settings().remove(PENDING_OWNER_KEY);
    await settings().remove(LAST_UPSERT_KEY);
    expect(await bg(snap())).toBe('skipped');
    expect(fake.calls).toHaveLength(0);
  });

  it('never writes under a session that is not the device owner', async () => {
    await seedDevice();
    fake.sessionUid = 'user-b';
    expect(await bg(snap())).toBe('skipped');
    expect(fake.calls).toHaveLength(0);
  });

  it('the wake hook folds wakes during a run into one more run, never side by side', async () => {
    await seedDevice();
    let reads = 0;
    let inFlight = 0;
    let most = 0;
    const hook = createBackgroundPermissionReporter({
      db,
      supabase: fake.client,
      now: () => now,
      adapter: {
        snapshot: async () => {
          reads += 1;
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return snap();
        },
      },
    });
    await Promise.all([hook(), hook(), hook(), hook()]);
    expect(most).toBe(1);
    expect(reads).toBe(2);
  });
});
