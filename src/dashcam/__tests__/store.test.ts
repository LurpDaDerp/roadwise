/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createTripsRepo, migrate, type Db } from '@/data/db';

import { BOOT_GENERATION, createDashcamStore, wireBootId, type DashcamStore } from '../store';

const CAM = 'a4cf12b3c4d5';
let db: Db;
let store: DashcamStore;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  store = createDashcamStore(db);
});

const put = (seq: number, boot = 9, received = 1) =>
  store.insertEvent({
    dashcamId: CAM,
    bootKey: boot,
    seq,
    id: `id-${boot}-${seq}`,
    ev: 0,
    name: 'MICROSLEEP',
    tier: 3,
    audible: true,
    detail: 0,
    tMs: 1000 + seq,
    durDs: 1,
    value: 0.5,
    atMs: null,
    startedAtMs: null,
    receivedAtMs: received,
  });

test('the cursor is the lowest seq at or above the floor not yet stored', async () => {
  await store.ensureBoot(CAM, 9, 0);
  expect(await store.cursor(CAM, 9, 0)).toBe(0);
  await put(1);
  expect(await store.cursor(CAM, 9, 0)).toBe(0);
  await put(0);
  expect(await store.cursor(CAM, 9, 0)).toBe(2);
  await put(3);
  await put(4);
  expect(await store.cursor(CAM, 9, 0)).toBe(2);
  // A gap below the dashcam's oldest seq is permanent: the floor moves past it.
  expect(await store.cursor(CAM, 9, 3)).toBe(5);
  expect(await store.cursor(CAM, 9, 7)).toBe(7);
});

test('insert is deduplicated and keeps the first id; max_seq follows', async () => {
  await store.ensureBoot(CAM, 9, 0);
  expect(await put(5)).toBe(true);
  expect(
    await store.insertEvent({
      dashcamId: CAM, bootKey: 9, seq: 5, id: 'another', ev: 0, name: 'MICROSLEEP', tier: 3, audible: true, detail: 0,
      tMs: 1, durDs: 1, value: 0, atMs: null, startedAtMs: null, receivedAtMs: 2,
    })
  ).toBe(false);
  expect((await db.execute('SELECT id FROM dashcam_events')).rows).toEqual([{ id: 'id-9-5' }]);
  expect((await store.getBoot(CAM, 9))?.maxSeq).toBe(5);
  await put(2);
  expect((await store.getBoot(CAM, 9))?.maxSeq).toBe(5);
});

test('the ignored flag is the first copy’s: a later copy of the same seq neither duplicates nor changes it', async () => {
  await store.ensureBoot(CAM, 9, 0);
  const copy = (seq: number, id: string, ignored?: boolean) =>
    store.insertEvent({
      dashcamId: CAM, bootKey: 9, seq, id, ev: 0, name: 'MICROSLEEP', tier: 3, audible: true, detail: 0,
      tMs: 1, durDs: 1, value: 0, atMs: null, startedAtMs: null, receivedAtMs: 2, ignored,
    });
  expect(await copy(0, 'first-0', true)).toBe(true);
  expect(await copy(0, 'second-0', false)).toBe(false);
  expect(await copy(1, 'first-1', false)).toBe(true);
  expect(await copy(1, 'second-1', true)).toBe(false);
  expect(await copy(2, 'first-2')).toBe(true); // not given: received in a drive
  expect((await db.execute('SELECT seq, id, ignored FROM dashcam_events ORDER BY seq')).rows).toEqual([
    { seq: 0, id: 'first-0', ignored: 1 },
    { seq: 1, id: 'first-1', ignored: 0 },
    { seq: 2, id: 'first-2', ignored: 0 },
  ]);
  expect(await store.cursor(CAM, 9, 0)).toBe(3);
});

test('the floor only rises; the offset is replaced only by a shorter round trip', async () => {
  await store.ensureBoot(CAM, 9, 10);
  await store.ensureBoot(CAM, 9, 4);
  expect((await store.getBoot(CAM, 9))?.floorSeq).toBe(10);
  expect(await store.offerOffset(CAM, 9, 1000, 400)).toBe(true);
  expect(await store.offerOffset(CAM, 9, 2000, 500)).toBe(false);
  expect(await store.offerOffset(CAM, 9, 1100, 40)).toBe(true);
  expect(await store.getBoot(CAM, 9)).toMatchObject({ offsetMs: 1100, rttMs: 40 });
});

test('latestBoot finds the newest local generation of a wire boot id', async () => {
  expect(await store.latestBoot(CAM, 9)).toBeNull();
  await store.ensureBoot(CAM, 9, 0);
  await store.ensureBoot(CAM, 9 + BOOT_GENERATION, 0);
  await store.ensureBoot(CAM, 10, 0);
  expect((await store.latestBoot(CAM, 9))?.bootKey).toBe(9 + BOOT_GENERATION);
  expect(wireBootId(9 + BOOT_GENERATION)).toBe(9);
  expect(wireBootId(0xffffffff + BOOT_GENERATION * 3)).toBe(0xffffffff);
  expect(await store.latestBoot('0000000000ff', 9)).toBeNull();
});

test('coverage adds up per drive and keeps the last sync stamp; the 7-day prune takes only unattached events', async () => {
  const trip = '11111111-1111-4111-8111-111111111111';
  await createTripsRepo(db).insert({ client_trip_id: trip, started_at: 0, tz: 'UTC', status: 'recording' }, 0);
  await store.addCoverage(trip, 1, 1, 50);
  await store.addCoverage(trip, 1, 0, null);
  expect(await store.coverage(trip)).toEqual({ movingS: 2, coveredS: 1, lastSyncedAtMs: 50 });
  expect(await store.coverage('nope')).toBeNull();

  await store.ensureBoot(CAM, 9, 0);
  await put(0, 9, 100);
  await put(1, 9, 100);
  await put(2, 9, 900);
  await db.execute('UPDATE dashcam_events SET client_trip_id = ? WHERE seq = 1', [trip]);
  expect(await store.pruneUnattached(500)).toBe(1);
  expect((await db.execute('SELECT seq FROM dashcam_events ORDER BY seq')).rows).toEqual([{ seq: 1 }, { seq: 2 }]);
});

test('the prune never moves the cursor back: it raises the floor past the newest old event, gives up a gap below it, and a re-sent pruned seq is not stored again', async () => {
  await store.ensureBoot(CAM, 9, 0);
  for (const seq of [0, 1, 2, 3]) await put(seq, 9, 100);
  await put(5, 9, 100); // above the gap at 4
  await put(6, 9, 900); // recent: kept
  expect(await store.cursor(CAM, 9, 0)).toBe(4);
  // Another boot with an old event is pruned on its own; a boot with nothing old is untouched.
  await store.ensureBoot(CAM, 10, 0);
  await put(0, 10, 100);
  await store.ensureBoot(CAM, 11, 2);
  await put(2, 11, 900);
  // A boot whose stored floor is already above its old events keeps that floor.
  await store.ensureBoot(CAM, 12, 0);
  await put(0, 12, 100);
  await store.ensureBoot(CAM, 12, 3);

  expect(await store.pruneUnattached(500)).toBe(7);
  expect((await db.execute('SELECT boot_id, seq FROM dashcam_events ORDER BY boot_id, seq')).rows).toEqual([
    { boot_id: 9, seq: 6 },
    { boot_id: 11, seq: 2 },
  ]);
  expect((await store.getBoot(CAM, 9))?.floorSeq).toBe(6);
  expect((await store.getBoot(CAM, 10))?.floorSeq).toBe(1);
  expect((await store.getBoot(CAM, 11))?.floorSeq).toBe(2);
  expect((await store.getBoot(CAM, 12))?.floorSeq).toBe(3);
  // The link still holds the floor it loaded at the HELLO (0): the cursor does not fall back to it,
  // and the old gap at 4 is given up.
  expect(await store.cursor(CAM, 9, 0)).toBe(7);
  expect(await store.cursor(CAM, 10, 0)).toBe(1);

  // A whole-ring replay re-sends 0..6: nothing below the floor is stored again, the gap included.
  for (const seq of [0, 1, 2, 3, 4, 5, 6]) expect(await put(seq, 9, 1000)).toBe(false);
  expect(await put(7, 9, 1000)).toBe(true);
  expect(await store.cursor(CAM, 9, 0)).toBe(8);
  // A second prune with nothing old left changes nothing.
  expect(await store.pruneUnattached(500)).toBe(0);
  expect((await store.getBoot(CAM, 9))?.floorSeq).toBe(6);
  expect(await store.cursor(CAM, 9, 0)).toBe(8);
});
