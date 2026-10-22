/** @jest-environment node */
// The `DriveDetect` wrapper (plan §3.1.1): arguments checked before the bridge, results and event
// payloads validated after it, the contract lists as declared, and no module at all (Android, Jest,
// web) means `available` false, every method rejecting and every listener inert.
//
// Only the `DriveDetect` lookup is stubbed (see api.test.ts for why the rest of expo-modules-core stays real).
import {
  DRIVE_DETECT_ERROR_CODES,
  DRIVE_DETECT_EVENTS,
  DRIVE_DETECT_METHODS,
  DriveDetect,
  droppedDetectEvents,
  isDriveDetectError,
  resetDroppedDetectEvents,
  type DetectState,
} from '../src';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const state = {
    armed: true,
    ownerId: '3b2e4c1a-1111-4222-8333-444455556666',
    state: 'armed',
    origin: null,
    driveId: null,
    startedAt: null,
    since: 1_760_000_000_000,
    waitUntil: null,
    lastEnd: { decidedAt: 1_760_000_000_000, cut: 1_759_999_700_000, lat: 47.6, lng: -122.33, driveId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
    suppressedUntil: null,
    status: 'on',
    missing: [],
    permissions: { location: 'always', precise: true, motion: 'granted', backgroundRefresh: 'available', liveActivities: true, canAskAlways: false },
    journalDropped: 0,
  };
  const listeners = new Map<string, (mockPayload: unknown) => void>();
  const native = {
    state,
    listeners,
    setArmed: jest.fn(async () => state),
    getState: jest.fn(async () => state),
    requestAlways: jest.fn(async () => 'whenInUse'),
    startWaiting: jest.fn(async () => ({ ok: true, waitUntil: 1_760_000_300_000, driveId: ID, startedAt: 1_760_000_000_000 })),
    extendWaiting: jest.fn(async () => null),
    cancelWaiting: jest.fn(async () => undefined),
    notDriving: jest.fn(async () => null),
    listDrives: jest.fn(async () => []),
    readRows: jest.fn(async () => ({ rows: [{ seq: 1 }], lastSeq: 1, done: true })),
    discardDrive: jest.fn(async () => undefined),
    wipe: jest.fn(async () => null),
    appForeground: jest.fn(async () => null),
    addListener: jest.fn((event: string, fn: (mockPayload: unknown) => void) => {
      listeners.set(event, fn);
      return { remove: () => listeners.delete(event) };
    }),
  };
  return {
    ...actual,
    requireOptionalNativeModule: (name: string) => (name === 'DriveDetect' ? native : actual.requireOptionalNativeModule(name)),
    __detect: native,
  };
});

type Native = Record<string, jest.Mock> & { state: DetectState; listeners: Map<string, (p: unknown) => void> };
const native = (jest.requireMock('expo-modules-core') as { __detect: Native }).__detect;

describe('the contract lists', () => {
  test('three events, twelve methods, one error code', () => {
    expect([...DRIVE_DETECT_EVENTS]).toEqual(['detectState', 'driveStarted', 'driveEnded']);
    expect([...DRIVE_DETECT_METHODS]).toEqual(['setArmed', 'getState', 'requestAlways', 'startWaiting', 'extendWaiting', 'cancelWaiting', 'notDriving', 'listDrives', 'readRows', 'discardDrive', 'wipe', 'appForeground']);
    expect([...DRIVE_DETECT_ERROR_CODES]).toEqual(['E_BUSY']);
    for (const m of DRIVE_DETECT_METHODS) expect(typeof DriveDetect[m]).toBe('function');
  });

  test('isDriveDetectError knows E_BUSY only', () => {
    expect(isDriveDetectError(Object.assign(new Error('x'), { code: 'E_BUSY' }))).toBe(true);
    expect(isDriveDetectError(Object.assign(new Error('x'), { code: 'E_BUSY' }), 'E_BUSY')).toBe(true);
    expect(isDriveDetectError(Object.assign(new Error('x'), { code: 'E_PERMISSION' }))).toBe(false);
    expect(isDriveDetectError(null)).toBe(false);
  });
});

describe('with the native module', () => {
  test('is available, and passes arguments through untouched', async () => {
    expect(DriveDetect.available).toBe(true);
    await expect(DriveDetect.setArmed(true, native.state.ownerId!)).resolves.toEqual(native.state);
    expect(native.setArmed).toHaveBeenCalledWith(true, native.state.ownerId);
    await expect(DriveDetect.getState()).resolves.toEqual(native.state);
    await expect(DriveDetect.requestAlways()).resolves.toBe('whenInUse');
    await expect(DriveDetect.startWaiting()).resolves.toEqual({ ok: true, waitUntil: 1_760_000_300_000, driveId: ID, startedAt: 1_760_000_000_000 });
    await expect(DriveDetect.extendWaiting()).resolves.toBeNull();
    await expect(DriveDetect.cancelWaiting()).resolves.toBeUndefined();
    await expect(DriveDetect.notDriving()).resolves.toBeUndefined();
    await expect(DriveDetect.listDrives()).resolves.toEqual([]);
    await expect(DriveDetect.readRows(ID, 0, 300)).resolves.toEqual({ rows: [{ seq: 1 }], lastSeq: 1, done: true });
    expect(native.readRows).toHaveBeenCalledWith(ID, 0, 300);
    await expect(DriveDetect.discardDrive(ID)).resolves.toBeUndefined();
    expect(native.discardDrive).toHaveBeenCalledWith(ID);
    await expect(DriveDetect.wipe()).resolves.toBeUndefined();
    expect(native.wipe).toHaveBeenCalledWith();
    await expect(DriveDetect.appForeground()).resolves.toBeUndefined();
    expect(native.appForeground).toHaveBeenCalledWith();
  });

  test('startWaiting takes the answer of a native build from before the drive opened at the tap: no drive id or start', async () => {
    native.startWaiting!.mockResolvedValueOnce({ ok: true, waitUntil: 1_760_000_300_000 });
    await expect(DriveDetect.startWaiting()).resolves.toEqual({ ok: true, waitUntil: 1_760_000_300_000, driveId: null, startedAt: null });
    native.startWaiting!.mockResolvedValueOnce({ ok: false, reason: 'busy' });
    await expect(DriveDetect.startWaiting()).resolves.toEqual({ ok: false, reason: 'busy' });
  });

  test('appForeground resolves on a native build that has no such method, and rejects a malformed answer', async () => {
    const fn = native.appForeground!;
    delete (native as Record<string, unknown>).appForeground;
    try {
      await expect(DriveDetect.appForeground()).resolves.toBeUndefined();
    } finally {
      native.appForeground = fn;
    }
    fn.mockResolvedValueOnce({ woke: true });
    await expect(DriveDetect.appForeground()).rejects.toThrow('DriveDetect.appForeground: invalid result');
  });

  test('wipe rejects a malformed native result like every other method', async () => {
    native.wipe!.mockResolvedValueOnce({ wiped: true });
    await expect(DriveDetect.wipe()).rejects.toThrow('DriveDetect.wipe: invalid result');
  });

  test.each([
    ['setArmed', [true, '']],
    ['setArmed', ['yes', 'owner-1']],
    ['setArmed', [true, 'has space']],
    ['readRows', ['NOT-A-UUID', 0, 10]],
    ['readRows', [ID.toUpperCase(), 0, 10]],
    ['readRows', [ID, -1, 10]],
    ['readRows', [ID, 1.5, 10]],
    ['readRows', [ID, 0, 0]],
    ['readRows', [ID, 0, 601]],
    ['discardDrive', ['x']],
  ] as const)('%s rejects bad arguments %j before the bridge', async (method, args) => {
    const fn = DriveDetect[method] as (...a: unknown[]) => Promise<unknown>;
    const before = native[method]!.mock.calls.length;
    await expect(fn(...args)).rejects.toThrow(`DriveDetect.${method}: invalid arguments`);
    expect(native[method]!.mock.calls.length).toBe(before);
  });

  test.each([
    ['getState', { armed: 'yes' }],
    ['startWaiting', { ok: true }],
    ['startWaiting', { ok: true, waitUntil: 1_760_000_300_000, driveId: ID }],
    ['startWaiting', { ok: true, waitUntil: 1_760_000_300_000, extra: 1 }],
    ['startWaiting', { ok: true, waitUntil: -1 }],
    ['startWaiting', { ok: true, waitUntil: 1_760_000_300_000, driveId: 'x', startedAt: 1_760_000_000_000 }],
    ['startWaiting', { ok: false, reason: 'tired' }],
    ['extendWaiting', 1.5],
    ['requestAlways', 'sometimes'],
    ['readRows', { rows: [], lastSeq: -1, done: true }],
    ['readRows', { rows: Array.from({ length: 601 }, () => ({})), lastSeq: 601, done: false }],
    ['listDrives', [{ driveId: ID }]],
  ] as const)('%s rejects a malformed native result', async (method, bad) => {
    native[method]!.mockResolvedValueOnce(bad);
    const args = method === 'readRows' ? [ID, 0, 10] : [];
    await expect((DriveDetect[method] as (...a: unknown[]) => Promise<unknown>)(...args)).rejects.toThrow(`DriveDetect.${method}: invalid result`);
  });

  test('a state with a journaled drive and every field set parses', async () => {
    const live: DetectState = {
      ...native.state,
      state: 'recording',
      origin: 'manual',
      driveId: ID,
      startedAt: 1_760_000_100_000,
      suppressedUntil: null,
      status: 'needs',
      missing: ['backgroundRefresh', 'liveActivities'],
    };
    native.getState!.mockResolvedValueOnce(live);
    await expect(DriveDetect.getState()).resolves.toEqual(live);
    const drive = {
      driveId: ID,
      origin: 'auto',
      startedAt: 1,
      startSource: 'motion',
      startLat: null,
      startLng: null,
      continues: true,
      confirmedAt: 2,
      firstSeq: 1,
      lastSeq: 0,
      lastRowTs: null,
      bytes: 210,
      ended: { endedAt: 3, cause: 'js', decidedAt: 3 },
    };
    native.listDrives!.mockResolvedValueOnce([drive]);
    await expect(DriveDetect.listDrives()).resolves.toEqual([drive]);
  });

  test('events reach a listener validated; a malformed payload is dropped and counted', () => {
    resetDroppedDetectEvents();
    const started = jest.fn();
    const sub = DriveDetect.addListener('driveStarted', started);
    const fire = native.listeners.get('driveStarted')!;
    const ok = { driveId: ID, origin: 'auto', startedAt: 1, startSource: 'trace', startLat: 47.6, startLng: -122.33, continues: false, confirmedAt: 2, firstSeq: 1 };
    fire(ok);
    fire({ ...ok, startSource: 'guess' });
    fire({ ...ok, extra: 1 });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(ok);
    expect(droppedDetectEvents()).toBe(2);
    sub.remove();
    const ended = jest.fn();
    DriveDetect.addListener('driveEnded', ended);
    native.listeners.get('driveEnded')!({ driveId: ID, endedAt: 5, cause: 'cancelled', decidedAt: 5, lastSeq: 3, lastRowTs: 4 });
    native.listeners.get('driveEnded')!({ driveId: ID, endedAt: 5, cause: 'js', decidedAt: 5, lastSeq: 3, lastRowTs: 4 });
    expect(ended).toHaveBeenCalledTimes(1);
    const state = jest.fn();
    DriveDetect.addListener('detectState', state);
    native.listeners.get('detectState')!({ ...native.state, reason: 'wake:region' });
    native.listeners.get('detectState')!({ ...native.state, reason: 'phone' });
    for (const reason of ['wake:app', 'linger', 'cap']) native.listeners.get('detectState')!({ ...native.state, reason });
    expect(state).toHaveBeenCalledTimes(4);
  });
});
