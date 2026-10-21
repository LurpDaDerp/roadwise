/** @jest-environment node */
import { createFakeDriveDetect } from '@drive-sense';

import { AUTO_DETECT_ONBOARDED_KEY, autoDetectOff, autoDetectSync, readAutoDetectStatus, setAutoDetectRuntime } from '@/boot/autoDetect';
import { SIGN_OUT_SETTINGS, wipeDevice, wipeForSignOut } from '@/boot/device';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, SPOTS_META_KEY, type Db } from '@/data/db';
import { NOT_DRIVING_KEY } from '@/drive/notDriving';

jest.mock('expo-notifications', () => ({}));

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});
afterEach(() => setAutoDetectRuntime(null));

function rig(opts: { uid?: string | null; onboarded?: boolean; available?: boolean } = {}) {
  const detect = createFakeDriveDetect({ available: opts.available ?? true });
  setAutoDetectRuntime({ db, detect, uid: async () => (opts.uid === undefined ? 'user-1' : opts.uid), onboarded: () => opts.onboarded ?? false });
  return detect;
}

test('a signed-in driver seen onboarded (the summary says so, or onboarding just finished) is armed; the phone remembers', async () => {
  const detect = rig({ onboarded: true });
  expect(await autoDetectSync()).toBe('on');
  expect(detect.snapshot).toMatchObject({ armed: true, ownerId: 'user-1', state: 'armed' });
  expect(await createSettingsRepo(db).get(AUTO_DETECT_ONBOARDED_KEY)).toBe('user-1');

  setAutoDetectRuntime(null);
  const fresh = rig({ onboarded: false });
  expect(await autoDetectSync({ onboarded: true })).toBe('on');
  expect(fresh.snapshot.armed).toBe(true);
});

test('not onboarded, or signed out: disarmed; a missing permission answers needs (native stays off)', async () => {
  const detect = rig({ onboarded: false });
  expect(await autoDetectSync()).toBe('off');
  expect(detect.calls).toEqual(['setArmed:false']);
  setAutoDetectRuntime(null);
  const out = rig({ uid: null, onboarded: true });
  expect(await autoDetectSync()).toBe('off');
  expect(out.snapshot.armed).toBe(false);
  setAutoDetectRuntime(null);
  const needs = rig({ onboarded: true });
  needs.setPermissions({ location: 'whenInUse' });
  expect(await autoDetectSync()).toBe('needs');
  expect(needs.snapshot.armed).toBe(false);
});

test('a session that cannot be read (an expired token, no network) keeps the arming as it is; a real sign-out disarms', async () => {
  const detect = rig({ onboarded: true });
  expect(await autoDetectSync()).toBe('on');
  setAutoDetectRuntime({
    db,
    detect,
    uid: async () => {
      throw new Error('the session could not be read');
    },
    onboarded: () => true,
  });
  detect.calls.length = 0;
  expect(await autoDetectSync()).toBe('on');
  expect(detect.snapshot).toMatchObject({ armed: true, ownerId: 'user-1' });
  expect(detect.calls.filter((c) => c.startsWith('setArmed'))).toEqual([]);
  // Not armed before, unknown now: still not armed (nothing is armed on an unread session either).
  await detect.setArmed(false, 'user-1');
  detect.calls.length = 0;
  expect(await autoDetectSync()).toBe('off');
  expect(detect.calls.filter((c) => c.startsWith('setArmed'))).toEqual([]);
  await detect.setArmed(true, 'user-1');
  setAutoDetectRuntime({ db, detect, uid: async () => null });
  expect(await autoDetectSync()).toBe('off');
  expect(detect.snapshot.armed).toBe(false);
});

test('a disarm names the owner native is armed for, else the signed-in driver; never an empty id', async () => {
  const detect = rig({ onboarded: true });
  await autoDetectSync();
  const owners: string[] = [];
  const setArmed = detect.setArmed.bind(detect);
  detect.setArmed = (armed, ownerId) => (owners.push(ownerId), setArmed(armed, ownerId));
  setAutoDetectRuntime({ db, detect, uid: async () => null });
  await autoDetectOff();
  expect(owners).toEqual(['user-1']);
  expect(detect.snapshot.armed).toBe(false);
  // Signed out with native already disarmed: the placeholder, never ''.
  await autoDetectSync();
  expect(owners).toEqual(['user-1', 'none']);
});

test('Android (no detector): every call is a no-op and the status is null', async () => {
  const detect = rig({ available: false, onboarded: true });
  expect(await autoDetectSync()).toBe('unsupported');
  await autoDetectOff();
  expect(await readAutoDetectStatus()).toBeNull();
  expect(detect.calls).toEqual([]);
  setAutoDetectRuntime(null);
  expect(await readAutoDetectStatus()).toBeNull();
});

test('the status Settings and Home read: armed, on or needs, what is missing, the permissions', async () => {
  const detect = rig({ onboarded: true });
  detect.setPermissions({ backgroundRefresh: 'denied' });
  await autoDetectSync();
  const s = await readAutoDetectStatus();
  expect(s).toMatchObject({ status: expect.any(String), missing: expect.any(Array), permissions: { backgroundRefresh: 'denied' } });
});

test('both wipes disarm automatic drives (iPhone) and wipe native’s drive state (journals, last end, parked spot); the sign-out wipe takes the "Not driving?" budget and the spots bookkeeping', async () => {
  for (const wipe of [() => wipeForSignOut(db), () => wipeDevice(db)]) {
    const detect = rig({ onboarded: true });
    const wiped = jest.fn(async () => {});
    Object.assign(detect, { wipe: wiped });
    await autoDetectSync();
    expect(detect.snapshot.armed).toBe(true);
    await wipe();
    expect(detect.snapshot.armed).toBe(false);
    expect(wiped).toHaveBeenCalledTimes(1);
    setAutoDetectRuntime(null);
  }
  // A native build without `wipe`, or one that fails it: the wipe still runs to the end.
  const old = rig({ onboarded: true });
  await autoDetectSync();
  await wipeDevice(db);
  expect(old.snapshot.armed).toBe(false);
  const failing = rig({ onboarded: true });
  Object.assign(failing, { wipe: async () => Promise.reject(new Error('busy')) });
  await expect(wipeForSignOut(db)).resolves.toBeUndefined();
  // The launch's own detector (an account switch, before the runtime is registered) is the one wiped.
  setAutoDetectRuntime(null);
  const launch = createFakeDriveDetect();
  const launchWipe = jest.fn(async () => {});
  Object.assign(launch, { wipe: launchWipe });
  await launch.setArmed(true, 'user-1');
  await wipeDevice(db, { detect: launch });
  expect(launch.snapshot.armed).toBe(false);
  expect(launchWipe).toHaveBeenCalledTimes(1);
  expect(SIGN_OUT_SETTINGS).toEqual(expect.arrayContaining([NOT_DRIVING_KEY, SPOTS_META_KEY]));
  await createSettingsRepo(db).set(NOT_DRIVING_KEY, { clientTripId: 'x', spentMs: 1, expired: false, updatedAt: 1 });
  await wipeForSignOut(db);
  expect(await createSettingsRepo(db).get(NOT_DRIVING_KEY)).toBeNull();
});
