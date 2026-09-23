import type { ServerPermissions } from '@/core/permissions';

import { createFakeSupabase, createMemorySettings } from '../__fixtures__/fakeSupabase';
import {
  LAST_UPSERT_KEY,
  noteReportedFingerprint,
  UPSERT_INTERVAL_MS,
  upsertDevice,
  type DeviceInfo,
} from '../register';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);

const perms = (location: ServerPermissions['location'] = 'always'): ServerPermissions => ({
  v: 1,
  location,
  precise: true,
  motion: 'granted',
  notifications: 'granted',
  batteryOptimization: 'exempt',
  reportedFrom: 'foreground',
  ack: false,
  checkedAt: new Date(T0).toISOString(),
});

const info = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  platform: 'ios',
  model: 'iPhone 15',
  osVersion: '19.0',
  appVersion: '2.0.0',
  permissions: perms(),
  ...over,
});

function setup() {
  const fake = createFakeSupabase();
  const settings = createMemorySettings();
  let now = T0;
  const deps = { supabase: fake.client, settings, deviceId: 'install-1', now: () => now };
  return { fake, settings, deps, advance: (ms: number) => (now += ms) };
}

describe('upsertDevice', () => {
  it('sends only the briefed columns, keyed on (user_id, id)', async () => {
    const { fake, deps } = setup();
    expect(await upsertDevice('user-a', info(), deps)).toBe('saved');
    const [call] = fake.to('devices');
    expect(call?.op).toBe('upsert');
    expect(Object.keys(call?.values as object).sort()).toEqual(
      ['app_version', 'id', 'last_seen_at', 'model', 'os_version', 'permissions', 'platform', 'signed_out_at', 'user_id'].sort()
    );
    expect(call?.values).toMatchObject({
      id: 'install-1',
      user_id: 'user-a',
      platform: 'ios',
      model: 'iPhone 15',
      os_version: '19.0',
      app_version: '2.0.0',
      last_seen_at: new Date(T0).toISOString(),
    });
    expect(call?.options).toMatchObject({ onConflict: 'user_id,id' });
    // never the drive state, the push token or anything else the server owns
    expect(call?.values).not.toHaveProperty('drive_state');
    expect(call?.values).not.toHaveProperty('drive_state_at');
    expect(call?.values).not.toHaveProperty('push_token');
  });

  it('sends signed_out_at: null, so signing back in re-enrols the phone (M5 R-A), and never the watermark', async () => {
    const { fake, deps } = setup();
    await upsertDevice('user-a', info(), deps);
    const [call] = fake.to('devices');
    expect(call?.values).toHaveProperty('signed_out_at', null);
    // synced_through is the runner's to write after a clean drain; the upsert never moves it.
    expect(call?.values).not.toHaveProperty('synced_through');
  });

  it('leaves permissions out when nothing was reported yet, so the stored object is never blanked', async () => {
    const { fake, deps } = setup();
    await upsertDevice('user-a', info({ permissions: null }), deps);
    expect(fake.to('devices')[0]?.values).not.toHaveProperty('permissions');
  });

  it('writes at most once every 6 hours', async () => {
    const { fake, deps, advance } = setup();
    await upsertDevice('user-a', info(), deps);
    advance(UPSERT_INTERVAL_MS - 1);
    expect(await upsertDevice('user-a', info(), deps)).toBe('throttled');
    expect(fake.to('devices')).toHaveLength(1);
    advance(1);
    expect(await upsertDevice('user-a', info(), deps)).toBe('saved');
    expect(fake.to('devices')).toHaveLength(2);
  });

  it('a permissions fingerprint change bypasses the throttle', async () => {
    const { fake, deps, advance } = setup();
    await upsertDevice('user-a', info(), deps);
    advance(60_000);
    expect(await upsertDevice('user-a', info({ permissions: perms('foreground') }), deps)).toBe('saved');
    expect(fake.to('devices')).toHaveLength(2);
  });

  it('an app version change bypasses the throttle', async () => {
    const { fake, deps, advance } = setup();
    await upsertDevice('user-a', info(), deps);
    advance(60_000);
    expect(await upsertDevice('user-a', info({ appVersion: '2.0.1' }), deps)).toBe('saved');
    expect(fake.to('devices')).toHaveLength(2);
  });

  it('another account or another install id is never throttled by this one', async () => {
    const { fake, deps } = setup();
    await upsertDevice('user-a', info(), deps);
    expect(await upsertDevice('user-b', info(), deps)).toBe('saved');
    expect(await upsertDevice('user-b', info(), { ...deps, deviceId: 'install-2' })).toBe('saved');
    expect(fake.to('devices')).toHaveLength(3);
  });

  it('a failed write stamps nothing, so the next foreground tries again', async () => {
    const { fake, settings, deps } = setup();
    fake.respond = () => ({ data: null, error: { message: 'offline' } });
    expect(await upsertDevice('user-a', info(), deps)).toBe('error');
    expect(await settings.get(LAST_UPSERT_KEY)).toBeNull();
    fake.respond = () => ({ data: null, error: null });
    expect(await upsertDevice('user-a', info(), deps)).toBe('saved');
  });

  it('a clock that moved back does not hold the throttle shut', async () => {
    const { fake, deps, advance } = setup();
    await upsertDevice('user-a', info(), deps);
    advance(-60_000);
    expect(await upsertDevice('user-a', info(), deps)).toBe('saved');
    expect(fake.to('devices')).toHaveLength(2);
  });

  it('a permission report that already wrote the object moves the throttle fingerprint with it', async () => {
    const { fake, settings, deps, advance } = setup();
    await upsertDevice('user-a', info(), deps);
    await noteReportedFingerprint(settings, 'user-a', 'install-1', info({ permissions: perms('foreground') }).permissions!);
    advance(60_000);
    expect(await upsertDevice('user-a', info({ permissions: perms('foreground') }), deps)).toBe('throttled');
    expect(fake.to('devices')).toHaveLength(1);
  });
});
