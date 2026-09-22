import {
  EVER_GRANTED_KEY,
  permissionsFingerprint,
  toServerPermissions,
  type PermissionSnapshot,
  type ServerPermissions,
} from '@/core/permissions';
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { createSettingsRepo, type Db } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { SETTINGS_RETURN_ACK_KEY } from '@/features/permissions/usePermissionHealth';
import { LOCAL_SENT_KEY } from '@/notifications/keys';
import { recordLocalSent } from '@/notifications/localDelivery';

import { createFakeSupabase, type FakeSupabase } from '../__fixtures__/fakeSupabase';
import { INSTALL_ID_KEY } from '../installId';
import {
  createBackgroundPermissionReporter,
  readAlwaysExcused,
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

describe('final review I4: alwaysExcused', () => {
  const ctx = async (over: { autoDetect?: boolean; manual?: boolean; flag?: boolean } = {}) => {
    const s = settings();
    if (over.autoDetect !== undefined) await s.set('drive.autoDetect', over.autoDetect);
    if (over.manual !== undefined) await s.set('permissions.manualByChoice', over.manual);
    if (over.flag !== undefined) await s.set('config.app', { fetchedAt: T0, flags: { auto_detect: over.flag } });
  };

  it('auto-record wanted and offered: not excused', async () => {
    await ctx({ autoDetect: true });
    expect(await readAlwaysExcused(db, snap())).toBe(false);
  });

  it.each([
    ['auto-record off (the driver’s choice)', { autoDetect: false }],
    ['manual by choice', { autoDetect: true, manual: true }],
    ['the auto_detect flag withdrawn', { autoDetect: true, flag: false }],
  ] as const)('%s: excused', async (_label, over) => {
    await ctx(over);
    expect(await readAlwaysExcused(db, snap())).toBe(true);
  });

  it('an excused Always → While Using is reported with alwaysExcused: true', async () => {
    await ctx({ autoDetect: true, manual: true });
    const always = snap({ location: 'always' });
    await reportPermissions(
      { userId: 'user-a', deviceId: 'install-1', snapshot: always, reportedFrom: 'foreground', ack: false, alwaysExcused: await readAlwaysExcused(db, always) },
      { supabase: fake.client, settings: settings(), now: () => now }
    );
    const whileUsing = snap({ location: 'foreground' });
    expect(
      await reportPermissions(
        {
          userId: 'user-a',
          deviceId: 'install-1',
          snapshot: whileUsing,
          reportedFrom: 'foreground',
          ack: false,
          alwaysExcused: await readAlwaysExcused(db, whileUsing),
        },
        { supabase: fake.client, settings: settings(), now: () => now }
      )
    ).toBe('reported');
    expect(written().at(-1)).toMatchObject({ location: 'foreground', alwaysExcused: true });
  });

  it('a change of the excuse alone is reported (it is in the fingerprint), so the server knows before the next change', async () => {
    const same = snap({ location: 'always' });
    const report = (alwaysExcused: boolean) =>
      reportPermissions(
        { userId: 'user-a', deviceId: 'install-1', snapshot: same, reportedFrom: 'foreground', ack: false, alwaysExcused },
        { supabase: fake.client, settings: settings(), now: () => now }
      );
    expect(await report(false)).toBe('reported');
    expect(await report(false)).toBe('unchanged');
    expect(await report(true)).toBe('reported');
    expect(written().at(-1)).toMatchObject({ alwaysExcused: true });
  });

  it('every report carries alwaysExcused explicitly (true or false, never omitted)', async () => {
    await reportPermissions(
      { userId: 'user-a', deviceId: 'install-1', snapshot: snap(), reportedFrom: 'foreground', ack: false },
      { supabase: fake.client, settings: settings(), now: () => now }
    );
    expect(written().at(-1)).toHaveProperty('alwaysExcused', false);
  });

  it('contract (b9679a8): excused, then auto-record turned on, then Always lost — the lapse write carries alwaysExcused: false with location foreground', async () => {
    const report = async (snapshot: PermissionSnapshot) =>
      reportPermissions(
        {
          userId: 'user-a',
          deviceId: 'install-1',
          snapshot,
          reportedFrom: 'foreground',
          ack: false,
          alwaysExcused: await readAlwaysExcused(db, snapshot),
        },
        { supabase: fake.client, settings: settings(), now: () => now }
      );
    // Manual mode with Always: excused.
    await ctx({ autoDetect: false });
    expect(await report(snap({ location: 'always' }))).toBe('reported');
    expect(written().at(-1)).toMatchObject({ location: 'always', alwaysExcused: true });
    // The driver turns auto-record on: no longer excused, and the server is told.
    await ctx({ autoDetect: true });
    expect(await report(snap({ location: 'always' }))).toBe('reported');
    expect(written().at(-1)).toMatchObject({ location: 'always', alwaysExcused: false });
    // Always is lost: the lapse write itself says it is not excused, so no stale true can mute it.
    expect(await report(snap({ location: 'foreground' }))).toBe('reported');
    expect(written().at(-1)).toMatchObject({ location: 'foreground', alwaysExcused: false });
  });

  it('a settings read that fails counts as not excused: a real lapse is never hidden', async () => {
    const broken = { ...db, execute: async () => { throw new Error('disk'); } } as unknown as typeof db;
    expect(await readAlwaysExcused(broken, snap())).toBe(false);
  });
});

describe('reportPermissionsFromBackground', () => {
  async function seedDevice(owner = 'user-a') {
    const s = settings();
    await s.set(LAST_USER_KEY, owner);
    await s.set(INSTALL_ID_KEY, 'install-1');
    await s.set(LAST_UPSERT_KEY, { userId: owner, deviceId: 'install-1', at: T0, appVersion: '2.0.0', fingerprint: null });
    // A driver who wants auto-record: losing Always would be a real lapse (final review I4).
    await s.set('drive.autoDetect', true);
    // the foreground has reported once: only an onboarded account's host does that
    const permissions = toServerPermissions(snap(), 'foreground');
    await s.set(REPORTED_PERMISSIONS_KEY, {
      userId: owner,
      deviceId: 'install-1',
      fingerprint: permissionsFingerprint(permissions),
      permissions,
    });
  }
  const bg = (snapshot: PermissionSnapshot | (() => Promise<PermissionSnapshot>)) =>
    reportPermissionsFromBackground({
      db,
      supabase: fake.client,
      now: () => now,
      zone: () => 'UTC',
      adapter: { snapshot: typeof snapshot === 'function' ? snapshot : async () => snapshot },
    });

  it('reports a change as reportedFrom background, with the day count written first (N-I1)', async () => {
    await seedDevice();
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 2 });
    expect(await bg(snap({ location: 'foreground' }))).toBe('reported');
    const order = fake.calls.map((c) => `${c.target}:${c.op}`);
    expect(order).toEqual(['notification_prefs:update', 'devices:update']);
    expect(fake.to('notification_prefs')[0]?.values).toEqual({
      local_sent_day: '2026-09-22',
      local_sent_count: 2,
      tz: 'UTC',
    });
    expect(written()[0]).toMatchObject({ location: 'foreground', reportedFrom: 'background', ack: false });
  });

  it('inserts the count row when the account has none yet', async () => {
    await seedDevice();
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
      tz: 'UTC',
    });
  });

  it('an insert that lost the race to another writer (23505) is retried as an update', async () => {
    await seedDevice();
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 2 });
    let updates = 0;
    fake.respond = (c) => {
      if (c.target !== 'notification_prefs') return { data: c.columns ? [{ id: 'x' }] : null, error: null };
      if (c.op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } };
      updates += 1;
      return { data: updates === 1 ? [] : [{ user_id: 'user-a' }], error: null };
    };
    const onError = jest.fn();
    expect(
      await reportPermissionsFromBackground({
        db,
        supabase: fake.client,
        now: () => now,
        zone: () => 'UTC',
        onError,
        adapter: { snapshot: async () => snap({ location: 'foreground' }) },
      })
    ).toBe('reported');
    expect(fake.to('notification_prefs').map((c) => c.op)).toEqual(['update', 'insert', 'update']);
    expect(fake.to('notification_prefs')[2]?.values).toEqual({
      local_sent_day: '2026-09-22',
      local_sent_count: 2,
      tz: 'UTC',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a summary deferred into today counts, though the exported key still names yesterday (T7 concern 2)', async () => {
    await seedDevice();
    // Last night at 23:52 two summaries had been shown and a third was deferred to 07:00 today;
    // the app has not been opened since, so the export was last written yesterday.
    const LA = 'America/Los_Angeles';
    const lastNight = Date.parse('2026-09-22T06:52:00Z'); // 23:52 PDT on 09-21
    await recordLocalSent(settings(), LA, lastNight - 120_000);
    await recordLocalSent(settings(), LA, lastNight - 60_000);
    await recordLocalSent(settings(), LA, lastNight, {
      id: 'drive-summary:x',
      at: Date.parse('2026-09-22T14:00:00Z'), // 07:00 PDT on 09-22
    });
    expect(await settings().get(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-21', count: 2 });
    now = Date.parse('2026-09-22T16:00:00Z'); // 09:00 PDT
    expect(
      await reportPermissionsFromBackground({
        db,
        supabase: fake.client,
        now: () => now,
        zone: () => LA,
        adapter: { snapshot: async () => snap({ location: 'foreground' }) },
      })
    ).toBe('reported');
    expect(fake.to('notification_prefs')[0]?.values).toEqual({
      local_sent_day: '2026-09-22',
      local_sent_count: 1,
      tz: LA,
    });
    expect(await settings().get(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 1 });
  });

  it('sends the normalised zone with the count (T7 review m1)', async () => {
    await seedDevice();
    await reportPermissionsFromBackground({
      db,
      supabase: fake.client,
      now: () => now,
      zone: () => 'GMT+5',
      adapter: { snapshot: async () => snap({ location: 'foreground' }) },
    });
    expect(fake.to('notification_prefs')[0]?.values).toMatchObject({ tz: 'Etc/GMT-5' });
  });

  it('a zone the server refuses (22023) is dropped and the count is sent alone', async () => {
    await seedDevice();
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 1 });
    fake.respond = (c) => {
      if (c.target !== 'notification_prefs') return { data: c.columns ? [{ id: 'x' }] : null, error: null };
      const values = c.values as Record<string, unknown>;
      if ('tz' in values) return { data: null, error: { code: '22023', message: 'unknown time zone' } };
      return { data: [{ user_id: 'user-a' }], error: null };
    };
    const onError = jest.fn();
    expect(
      await reportPermissionsFromBackground({
        db,
        supabase: fake.client,
        now: () => now,
        zone: () => 'UTC',
        onError,
        adapter: { snapshot: async () => snap({ location: 'foreground' }) },
      })
    ).toBe('reported');
    expect(fake.to('notification_prefs').map((c) => c.values)).toEqual([
      { local_sent_day: '2026-09-22', local_sent_count: 1, tz: 'UTC' },
      { local_sent_day: '2026-09-22', local_sent_count: 1 },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("a zero count sends the zone alone, never overwriting another phone's count for today (T7 r1 n3)", async () => {
    await seedDevice();
    expect(await bg(snap({ location: 'foreground' }))).toBe('reported');
    expect(fake.to('notification_prefs').map((c) => c.values)).toEqual([{ tz: 'UTC' }]);
  });

  it('a zero count with the zone refused (22023) sends nothing more', async () => {
    await seedDevice();
    fake.respond = (c) =>
      c.target === 'notification_prefs'
        ? { data: null, error: { code: '22023', message: 'unknown time zone' } }
        : { data: [{ id: 'x' }], error: null };
    const onError = jest.fn();
    expect(
      await reportPermissionsFromBackground({
        db,
        supabase: fake.client,
        now: () => now,
        zone: () => 'UTC',
        onError,
        adapter: { snapshot: async () => snap({ location: 'foreground' }) },
      })
    ).toBe('reported');
    expect(fake.to('notification_prefs').map((c) => c.values)).toEqual([{ tz: 'UTC' }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a count that fails to send does not hold back the lapse report', async () => {
    await seedDevice();
    await settings().set(LOCAL_SENT_KEY, { day: '2026-09-22', count: 1 });
    fake.respond = (c) =>
      c.target === 'notification_prefs'
        ? { data: null, error: { message: 'nope' } }
        : { data: [{ id: 'x' }], error: null };
    expect(await bg(snap({ location: 'foreground' }))).toBe('reported');
  });

  it('no change: no network at all (no session read, no request)', async () => {
    await seedDevice();
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

  it('skipped with no owner, a pending handover, no install id, no device row or no foreground report yet', async () => {
    expect(await bg(snap())).toBe('skipped');
    await seedDevice();
    await settings().set(PENDING_OWNER_KEY, 'user-b');
    expect(await bg(snap())).toBe('skipped');
    await settings().remove(PENDING_OWNER_KEY);
    await settings().remove(LAST_UPSERT_KEY);
    expect(await bg(snap())).toBe('skipped');
    await seedDevice();
    // registered for the push token while onboarding, but never reported from the foreground
    await settings().remove(REPORTED_PERMISSIONS_KEY);
    expect(await bg(snap({ location: 'foreground' }))).toBe('skipped');
    expect(fake.calls).toHaveLength(0);
  });

  it('never writes under a session that is not the device owner', async () => {
    await seedDevice();
    fake.sessionUid = 'user-b';
    expect(await bg(snap({ location: 'foreground' }))).toBe('skipped');
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
