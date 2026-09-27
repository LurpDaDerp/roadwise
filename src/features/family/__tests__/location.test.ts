/** @jest-environment node */
import { DISCLOSURE_AFFIRMED_KEY } from '@/core/permissions/keys';
import { createSettingsRepo } from '@/data/db/settings';
import type { Db } from '@/data/db/driver';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { SESSION_UID_KEY } from '@/data/sync/queue';

import { FamilyError } from '../api';
import { attachFamilyLocation, FAMILY_SHARING_KEY, writeSharingRecord, type Fix } from '../location';
import { UID } from '../__fixtures__/world';

function fakeSource() {
  const listeners: Record<string, ((p: unknown) => void)[]> = { row: [], wake: [] };
  return {
    addListener: (event: 'row' | 'wake', fn: (p: unknown) => void) => {
      listeners[event]!.push(fn);
      return { remove: () => void (listeners[event] = listeners[event]!.filter((f) => f !== fn)) };
    },
    emit: (event: 'row' | 'wake', payload: unknown) => listeners[event]!.forEach((f) => f(payload)),
    count: () => listeners.row!.length + listeners.wake!.length,
  };
}

function fakeAppState() {
  const listeners: ((s: string) => void)[] = [];
  return {
    currentState: 'active' as string | null,
    addEventListener: (_t: 'change', fn: (s: string) => void) => {
      listeners.push(fn);
      return { remove: () => void listeners.splice(listeners.indexOf(fn), 1) };
    },
    emit: (s: string) => listeners.forEach((f) => f(s)),
    count: () => listeners.length,
  };
}

const row = (over: Record<string, number> = {}) => ({ ts: 1, lat: 47.61, lng: -122.33, hAcc: 8, speed: 12, ...over });

let db: Db;
let clock: number;
let recording: boolean;
let lastKnown: Fix | null;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((r) => setImmediate(() => r()));
};

beforeEach(async () => {
  db = await createTestDb();
  await createSettingsRepo(db).set(SESSION_UID_KEY, UID);
  // pd-2, the disclosure naming family sharing, affirmed by this account (the tests below remove it)
  await createSettingsRepo(db).set(DISCLOSURE_AFFIRMED_KEY, { version: 'pd-2', at: 1, uid: UID });
  clock = 1_000_000;
  recording = true;
  lastKnown = { lat: 47.62, lng: -122.35, accuracyM: 20 };
});

function attach() {
  const source = fakeSource();
  const appState = fakeAppState();
  const postLocation = jest.fn(async () => true);
  const poster = attachFamilyLocation({
    db,
    source,
    recording: () => recording,
    appState,
    now: () => clock,
    lastKnown: async () => lastKnown,
    api: { postLocation },
  });
  return { source, appState, postLocation, poster };
}

describe('pd-2 gates every post', () => {
  const tryAll = async (h: ReturnType<typeof attach>) => {
    h.source.emit('row', row());
    await flush();
    clock += 61_000;
    h.source.emit('wake', { reason: 'significant-change' });
    await flush();
    clock += 61_000;
    lastKnown = { lat: 47.7, lng: -122.4, accuracyM: 20 };
    h.appState.emit('active');
    await flush();
  };

  it.each([
    ['no affirmation', null],
    ['a pd-1 affirmation (words that do not name family sharing)', { version: 'pd-1', at: 1, uid: UID }],
    ['a pd-2 affirmation by another account', { version: 'pd-2', at: 1, uid: 'someone-else' }],
  ])('with %s: no drive row, wake or foreground posts', async (_label, affirmation) => {
    const settings = createSettingsRepo(db);
    if (affirmation === null) await settings.remove(DISCLOSURE_AFFIRMED_KEY);
    else await settings.set(DISCLOSURE_AFFIRMED_KEY, affirmation);
    await writeSharingRecord(db, UID, true);
    const h = attach();
    await tryAll(h);
    expect(h.postLocation).not.toHaveBeenCalled();
    h.poster.detach();
  });

  it('control: with pd-2 affirmed by this account, each of them posts', async () => {
    await writeSharingRecord(db, UID, true);
    const h = attach();
    await tryAll(h);
    expect(h.postLocation).toHaveBeenCalledTimes(3);
    h.poster.detach();
  });

  it('a server refusal for a consent not yet recorded is not reported as an error', async () => {
    await writeSharingRecord(db, UID, true);
    const onError = jest.fn();
    const postLocation = jest.fn(async () => {
      throw new FamilyError('disclosure_required');
    });
    const source = fakeSource();
    const poster = attachFamilyLocation({
      db,
      source,
      recording: () => true,
      appState: fakeAppState(),
      now: () => clock,
      lastKnown: async () => lastKnown,
      api: { postLocation },
      onError,
    });
    source.emit('row', row());
    await flush();
    expect(postLocation).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    poster.detach();
  });
});

it('posts nothing while sharing is off, and nothing for another account', async () => {
  const { source, appState, postLocation, poster } = attach();
  source.emit('row', row());
  appState.emit('active');
  await flush();
  expect(postLocation).not.toHaveBeenCalled();
  await writeSharingRecord(db, 'someone-else', true);
  source.emit('row', row());
  await flush();
  expect(postLocation).not.toHaveBeenCalled();
  poster.detach();
});

it('during a recorded drive: the drive’s own fix, at most once a minute, never while stationary', async () => {
  await writeSharingRecord(db, UID, true);
  const { source, postLocation, poster } = attach();
  source.emit('row', row());
  await flush();
  expect(postLocation).toHaveBeenCalledWith({ lat: 47.61, lng: -122.33, accuracyM: 8, driving: true });
  clock += 30_000;
  source.emit('row', row());
  await flush();
  expect(postLocation).toHaveBeenCalledTimes(1);
  clock += 31_000;
  source.emit('row', row({ speed: 0.2 }));
  await flush();
  expect(postLocation).toHaveBeenCalledTimes(1);
  source.emit('row', row({ lat: 47.7 }));
  await flush();
  expect(postLocation).toHaveBeenCalledTimes(2);
  poster.detach();
});

it('a row with no drive recording, or an invalid fix, posts nothing', async () => {
  await writeSharingRecord(db, UID, true);
  const { source, postLocation, poster } = attach();
  recording = false;
  source.emit('row', row());
  recording = true;
  source.emit('row', { lat: 'x' });
  source.emit('row', row({ lat: 0, lng: 0 }));
  source.emit('row', row({ hAcc: 900 }));
  await flush();
  expect(postLocation).not.toHaveBeenCalled();
  poster.detach();
});

it('an OS wake and the app coming to the front post the last known fix, only after moving', async () => {
  await writeSharingRecord(db, UID, true);
  const { source, appState, postLocation, poster } = attach();
  source.emit('wake', { reason: 'significantChange', ts: 1 });
  await flush();
  expect(postLocation).toHaveBeenCalledWith({ lat: 47.62, lng: -122.35, accuracyM: 20, driving: false });
  clock += 61_000;
  appState.emit('active');
  await flush();
  expect(postLocation).toHaveBeenCalledTimes(1);
  lastKnown = { lat: 47.7, lng: -122.35, accuracyM: 20 };
  appState.emit('active');
  await flush();
  expect(postLocation).toHaveBeenCalledTimes(2);
  lastKnown = null;
  clock += 61_000;
  source.emit('wake', { reason: 'activityTransition', ts: 2 });
  await flush();
  expect(postLocation).toHaveBeenCalledTimes(2);
  poster.detach();
});

it('the server saying sharing is off turns the phone’s record off, so it stops trying', async () => {
  await writeSharingRecord(db, UID, true);
  const source = fakeSource();
  const postLocation = jest.fn(async () => {
    throw new FamilyError('sharing_off');
  });
  const poster = attachFamilyLocation({
    db,
    source,
    recording: () => true,
    appState: fakeAppState(),
    now: () => clock,
    lastKnown: async () => null,
    api: { postLocation },
  });
  source.emit('row', row());
  await flush();
  await poster.settled();
  expect(await createSettingsRepo(db).get(FAMILY_SHARING_KEY)).toEqual({ uid: UID, on: false });
  poster.detach();
});

it('detach lets go of every listener', () => {
  const { source, appState, poster } = attach();
  expect(source.count()).toBe(2);
  expect(appState.count()).toBe(1);
  poster.detach();
  expect(source.count()).toBe(0);
  expect(appState.count()).toBe(0);
});
