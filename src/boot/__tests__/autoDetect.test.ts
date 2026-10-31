/** @jest-environment node */
import { createFakeDriveDetect } from '@drive-sense';

import {
  AUTO_DETECT_ENABLED_KEY,
  AUTO_DETECT_ONBOARDED_KEY,
  autoDetectForeground,
  autoDetectOff,
  autoDetectSync,
  forgetCar,
  notMyCar,
  onCarLink,
  pairCar,
  readAutoDetectEnabled,
  readCarLink,
  readAutoDetectStatus,
  setAutoDetectEnabled,
  setAutoDetectRuntime,
} from '@/boot/autoDetect';
import { SIGN_OUT_SETTINGS, wipeDevice, wipeForSignOut } from '@/boot/device';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, SPOTS_META_KEY, type Db } from '@/data/db';
import { NOT_DRIVING_KEY } from '@/drive/notDriving';
import { DRIVE_SCREEN_ENTERED_KEY } from '@/features/drive/hudPresence';

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
  Object.assign(old, { wipe: undefined });
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
  expect(SIGN_OUT_SETTINGS).toEqual(expect.arrayContaining([NOT_DRIVING_KEY, SPOTS_META_KEY, DRIVE_SCREEN_ENTERED_KEY]));
  await createSettingsRepo(db).set(NOT_DRIVING_KEY, { clientTripId: 'x', spentMs: 1, expired: false, updatedAt: 1 });
  await createSettingsRepo(db).set(DRIVE_SCREEN_ENTERED_KEY, 'x');
  await wipeForSignOut(db);
  expect(await createSettingsRepo(db).get(NOT_DRIVING_KEY)).toBeNull();
  expect(await createSettingsRepo(db).get(DRIVE_SCREEN_ENTERED_KEY)).toBeNull();
});

describe('the Automatic drives switch', () => {
  const armCalls = (detect: ReturnType<typeof rig>) => detect.calls.filter((c) => c.startsWith('setArmed'));

  test('on by default: nothing stored reads as on, and only a stored false is off', async () => {
    expect(await readAutoDetectEnabled(db)).toBe(true);
    await createSettingsRepo(db).set(AUTO_DETECT_ENABLED_KEY, 'no');
    expect(await readAutoDetectEnabled(db)).toBe(true);
    await createSettingsRepo(db).set(AUTO_DETECT_ENABLED_KEY, false);
    expect(await readAutoDetectEnabled(db)).toBe(false);
  });

  test('off disarms, and no sync re-arms it (a return to the front, a sign-in, the end of onboarding); on arms again', async () => {
    const detect = rig({ onboarded: true });
    expect(await autoDetectSync()).toBe('on');
    expect(await setAutoDetectEnabled(false)).toBe('disabled');
    expect(detect.snapshot.armed).toBe(false);
    expect(await createSettingsRepo(db).get(AUTO_DETECT_ENABLED_KEY)).toBe(false);
    detect.calls.length = 0;
    expect(await autoDetectSync()).toBe('disabled');
    expect(await autoDetectForeground()).toBe('disabled');
    expect(await autoDetectSync({ onboarded: true })).toBe('disabled');
    expect(detect.snapshot.armed).toBe(false);
    expect(armCalls(detect)).toEqual(['setArmed:false', 'setArmed:false', 'setArmed:false']);
    expect(detect.calls).not.toContain('appForeground');
    // the end of onboarding still records the driver as onboarded, for when the switch comes back on
    expect(await createSettingsRepo(db).get(AUTO_DETECT_ONBOARDED_KEY)).toBe('user-1');
    expect(await setAutoDetectEnabled(true)).toBe('on');
    expect(detect.snapshot).toMatchObject({ armed: true, ownerId: 'user-1', state: 'armed' });
    expect(await readAutoDetectEnabled(db)).toBe(true);
  });

  test('switched off with the session unreadable, or signed out: still disarmed', async () => {
    const detect = rig({ onboarded: true });
    await autoDetectSync();
    await createSettingsRepo(db).set(AUTO_DETECT_ENABLED_KEY, false);
    setAutoDetectRuntime({
      db,
      detect,
      uid: async () => {
        throw new Error('the session could not be read');
      },
      onboarded: () => true,
    });
    expect(await autoDetectSync()).toBe('disabled');
    expect(detect.snapshot.armed).toBe(false);
    setAutoDetectRuntime({ db, detect, uid: async () => null });
    expect(await autoDetectSync()).toBe('disabled');
    expect(detect.snapshot.armed).toBe(false);
  });

  test('off disarms at once, even while a sync is still reading the session, and that sync never arms after it', async () => {
    const detect = createFakeDriveDetect();
    let release: (uid: string) => void = () => {};
    let slow = true;
    setAutoDetectRuntime({
      db,
      detect,
      uid: () => (slow ? new Promise<string>((r) => (release = r)) : Promise.resolve('user-1')),
      onboarded: () => true,
    });
    await detect.setArmed(true, 'user-1');
    detect.calls.length = 0;
    const foreground = autoDetectSync();
    await new Promise((r) => setTimeout(r, 0));
    slow = false;
    const off = setAutoDetectEnabled(false);
    await new Promise((r) => setTimeout(r, 0));
    // disarmed before the session read comes back
    expect(detect.snapshot.armed).toBe(false);
    release('user-1');
    expect(await foreground).toBe('disabled');
    expect(await off).toBe('disabled');
    expect(detect.snapshot.armed).toBe(false);
    expect(detect.calls.filter((c) => c === 'setArmed:true')).toEqual([]);
  });

  test('syncs run one at a time, in call order: the last call decides', async () => {
    const detect = rig({ onboarded: true });
    const order: string[] = [];
    const setArmed = detect.setArmed.bind(detect);
    detect.setArmed = async (armed, ownerId) => {
      order.push(`start ${String(armed)}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${String(armed)}`);
      return setArmed(armed, ownerId);
    };
    const a = autoDetectSync();
    const b = setAutoDetectEnabled(false);
    const c = setAutoDetectEnabled(true);
    await Promise.all([a, b, c]);
    expect(order.at(-1)).toBe('end true');
    expect(detect.snapshot.armed).toBe(true);
    // the syncs never overlap (the switch's own immediate disarm may run beside one)
    expect(order.filter((x) => x === 'start true').length).toBe(order.filter((x) => x === 'end true').length);
  });

  test('a drive recording when it is switched off finishes; native settles off after it', async () => {
    const detect = rig({ onboarded: true });
    await autoDetectSync();
    detect.wake();
    detect.confirm({ driveId: 'd-1', startedAt: 1, rows: [] });
    expect(detect.snapshot.state).toBe('recording');
    expect(await setAutoDetectEnabled(false)).toBe('disabled');
    expect(detect.snapshot.state).toBe('recording');
    expect(detect.calls).not.toContain('jsStop');
    detect.endFor('still', 2);
    expect(detect.snapshot).toMatchObject({ armed: false, state: 'off' });
  });

  test('the choice survives a relaunch (a new runtime over the same database)', async () => {
    rig({ onboarded: true });
    await setAutoDetectEnabled(false);
    setAutoDetectRuntime(null);
    const next = rig({ onboarded: true });
    expect(await autoDetectSync()).toBe('disabled');
    expect(next.snapshot.armed).toBe(false);
    expect((await readAutoDetectStatus())?.enabled).toBe(false);
  });

  test('the device wipe (an account switch, a deletion) takes it, so the next driver starts on; a plain sign-out keeps it for the same driver', async () => {
    rig({ onboarded: true });
    await setAutoDetectEnabled(false);
    await wipeForSignOut(db);
    expect(await readAutoDetectEnabled(db)).toBe(false);
    await wipeDevice(db);
    expect(await readAutoDetectEnabled(db)).toBe(true);
    expect(await createSettingsRepo(db).get(AUTO_DETECT_ENABLED_KEY)).toBeNull();
  });

  test('the status says whether it is switched on', async () => {
    rig({ onboarded: true });
    expect((await readAutoDetectStatus())?.enabled).toBe(true);
    await setAutoDetectEnabled(false);
    expect(await readAutoDetectStatus()).toMatchObject({ enabled: false, armed: false });
  });

  test('Android (no detector): the switch is a no-op', async () => {
    const detect = rig({ available: false, onboarded: true });
    expect(await setAutoDetectEnabled(false)).toBe('unsupported');
    expect(await autoDetectForeground()).toBe('unsupported');
    expect(detect.calls).toEqual([]);
  });
});

describe('RoadWise coming to the front (autoDetectForeground)', () => {
  test('armed and on: the sync, then the app wake', async () => {
    const detect = rig({ onboarded: true });
    expect(await autoDetectForeground()).toBe('on');
    const i = detect.calls.indexOf('setArmed:true');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(detect.calls.indexOf('appForeground')).toBeGreaterThan(i);
  });

  test('not on (a permission missing, signed out): no app wake', async () => {
    const needs = rig({ onboarded: true });
    needs.setPermissions({ location: 'whenInUse' });
    expect(await autoDetectForeground()).toBe('needs');
    expect(needs.calls).not.toContain('appForeground');
    setAutoDetectRuntime(null);
    const fresh = rig({ uid: null, onboarded: true });
    expect(await autoDetectForeground()).toBe('off');
    expect(fresh.calls).not.toContain('appForeground');
  });

  test('a native build without the method, or one that fails it: the result stands, the failure is reported', async () => {
    const errors: string[] = [];
    const detect = createFakeDriveDetect();
    Object.assign(detect, { appForeground: undefined });
    setAutoDetectRuntime({ db, detect, uid: async () => 'user-1', onboarded: () => true, onError: (_e, ctx) => void errors.push(ctx) });
    expect(await autoDetectForeground()).toBe('on');
    Object.assign(detect, { appForeground: async () => Promise.reject(new Error('busy')) });
    expect(await autoDetectForeground()).toBe('on');
    expect(errors).toEqual(['autoDetectAppWake']);
  });
});

describe('the car link (readCarLink, pairCar, forgetCar, notMyCar, onCarLink)', () => {
  const civic = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' as const };

  test('reads, pairs, forgets and marks through the detector; every change reaches a subscriber', async () => {
    const detect = rig();
    detect.setCarRoute([civic]);
    const heard: boolean[] = [];
    const off = onCarLink((s) => heard.push(s.linked));
    expect(await readCarLink()).toMatchObject({ current: [civic], cars: [], linked: false });
    expect((await pairCar(civic.uid))?.linked).toBe(true);
    expect((await forgetCar(civic.uid))?.cars).toEqual([]);
    expect((await notMyCar(civic.uid))?.notMine).toEqual([civic.uid]);
    off();
    detect.setCarRoute([]);
    expect(heard).toEqual([true, false, false]);
  });

  test('the device wipe takes the paired cars with the rest of native drive state', async () => {
    const detect = rig({ onboarded: true });
    detect.setCarRoute([civic]);
    await pairCar(civic.uid);
    await autoDetectOff({ wipe: true });
    expect((await readCarLink())?.cars).toEqual([]);
  });

  test('Android, no runtime or a failing native build: null, never a rejection, the failure reported', async () => {
    rig({ available: false });
    expect(await readCarLink()).toBeNull();
    expect(onCarLink(() => {})).toEqual(expect.any(Function));
    setAutoDetectRuntime(null);
    const errors: string[] = [];
    const detect = createFakeDriveDetect();
    setAutoDetectRuntime({ db, detect, uid: async () => 'user-1', onError: (_e, ctx) => void errors.push(ctx) });
    // an older native build: null, quietly
    Object.defineProperty(detect, 'carLinkAvailable', { value: false, configurable: true });
    expect(await readCarLink()).toBeNull();
    expect(errors).toEqual([]);
    // one that has it but fails: null, reported
    Object.defineProperty(detect, 'carLinkAvailable', { value: true, configurable: true });
    Object.assign(detect, { carLinkState: async () => Promise.reject(new Error('busy')) });
    expect(await readCarLink()).toBeNull();
    expect(errors).toEqual(['carLink']);
  });
});
