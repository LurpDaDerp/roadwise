/** @jest-environment node */
import { createDetectors } from '@/core/detectors';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ } from '@/core/engine/__fixtures__/drives';
import { createEngine } from '@/core/engine/machine';
import { createRecorder } from '@/core/engine/recorder';
import { appendRow, closeAtLastMovement } from '@/core/engine/session';
import { finalizeTrip } from '@/core/engine/finalize';
import type { TripSession } from '@/core/engine/engine.types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { CONTINUE_DIST_M, CONTINUE_HOLD_MS, continuationFor, reopenTrip } from '@/drive/continuation';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const ID = '55555555-5555-4555-8555-555555555555';
const M_PER_DEG_LNG = 111_194.93 * Math.cos((47.6062 * Math.PI) / 180);
const lookup = () => null;
const rebuild = { createDetectors: () => createDetectors(() => 'x'), platform: 'ios' as const, limits: { lookup } };

/** A first leg recorded through the real engine and recorder: 600 s at 15 m/s, 300 s parked; finalized at its still end. */
async function firstLeg(): Promise<{ finalizedAt: number; end: { lat: number; lng: number }; session: Readonly<TripSession> }> {
  const recorder = createRecorder(db, { tz: TZ, now: () => T0 });
  let closed: Readonly<TripSession> | null = null;
  const engine = createEngine({
    now: () => T0,
    newId: () => ID,
    limits: { lookup, prefetch: () => {} },
    createDetectors: () => createDetectors(() => crypto.randomUUID()),
    ctx: () => ({ platform: 'ios' }),
    onAlert: () => {},
    onCheckpoint: (s) => recorder.onCheckpoint(s),
    onFinalize: async (s) => {
      closed = s;
    },
    onCancel: async () => {},
  });
  await engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
  const drive = rows(600);
  const parked = rows(301, { t0: T0 + 600_000, speedMps: 0 }).map((r) => ({ ...r, lng: drive.at(-1)!.lng }));
  for (const r of [...drive, ...parked]) await engine.dispatch({ type: 'row', row: r });
  expect(closed).not.toBeNull();
  const finalizedAt = T0 + 901_000;
  await finalizeTrip(closed!, { db, tz: TZ, now: () => finalizedAt, appVersion: '2.0.0', geocode: null, trimSeed: async () => '0'.repeat(64) });
  const trip = (await createTripsRepo(db).get(ID))!;
  return { finalizedAt, end: { lat: trip.end_lat!, lng: trip.end_lng! }, session: closed! };
}

const east = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat, lng: p.lng + m / M_PER_DEG_LNG });

test('the constants are the merge window: 5 min from the finalize, 150 m', () => {
  expect(CONTINUE_HOLD_MS).toBe(300_000);
  expect(CONTINUE_DIST_M).toBe(150);
});

test('a start 120 m from the end, 4 min after the finalize, continues the held drive; 160 m, 301 s, a null fix do not', async () => {
  const { finalizedAt, end } = await firstLeg();
  expect(await continuationFor(db, finalizedAt + 240_000, east(end, 120))).toEqual({ clientTripId: ID, finalizedAt, endFix: end });
  expect(await continuationFor(db, finalizedAt + 240_000, east(end, 160))).toBeNull();
  expect(await continuationFor(db, finalizedAt + CONTINUE_HOLD_MS + 1000, east(end, 20))).toBeNull();
  expect(await continuationFor(db, finalizedAt + 240_000, null)).toBeNull();
});

test('an upload already tried, sent or marked not driving, or a drive whose samples went, is never continued', async () => {
  const { finalizedAt, end } = await firstLeg();
  const now = finalizedAt + 60_000;
  const queue = createQueueRepo(db);
  const item = (await queue.byKey(`trip:${ID}`))!;
  await db.execute('UPDATE sync_queue SET attempts = 1 WHERE id = ?', [item.id]);
  expect(await continuationFor(db, now, end)).toBeNull();
  await db.execute("UPDATE sync_queue SET attempts = 0, status = 'done' WHERE id = ?", [item.id]);
  expect(await continuationFor(db, now, end)).toBeNull();
  await db.execute("UPDATE sync_queue SET status = 'pending' WHERE id = ?", [item.id]);
  expect(await continuationFor(db, now, end)).not.toBeNull();
  await db.execute("UPDATE trips SET status = 'not_driving' WHERE client_trip_id = ?", [ID]);
  expect(await continuationFor(db, now, end)).toBeNull();
  await db.execute("UPDATE trips SET status = 'pending' WHERE client_trip_id = ?", [ID]);
  await createSamplesRepo(db).purgeByTrip(ID);
  expect(await continuationFor(db, now, end)).toBeNull();
});

test('a held upload made due early (a report or "Wasn’t driving" on it, a sign-out’s flush) is never continued', async () => {
  const { finalizedAt, end } = await firstLeg();
  const now = finalizedAt + 60_000;
  expect(await continuationFor(db, now, end)).not.toBeNull();
  await createQueueRepo(db).makeDue(`trip:${ID}`, finalizedAt + 30_000);
  expect(await continuationFor(db, now, end)).toBeNull();
});

test('re-open: the held upload goes, the row records again with one more continuation, the session is the first leg rebuilt and its idle clock runs from the new start', async () => {
  const { finalizedAt, end, session } = await firstLeg();
  const at = finalizedAt + 120_000;
  const c = (await continuationFor(db, at + 30_000, end))!;
  const adopted = (await reopenTrip(db, c, { ...rebuild, now: at + 30_000, at }))!;
  expect(adopted).not.toBeNull();
  expect(await createQueueRepo(db).byKey(`trip:${ID}`)).toBeNull();
  expect(await createTripsRepo(db).get(ID)).toMatchObject({ status: 'recording', ended_at: null, end_cause: null, finalized_at: null, continuations: 1, origin: 'auto' });
  expect(adopted.session).toMatchObject({ clientTripId: ID, startedAt: T0, origin: 'auto', continuations: 1 });
  expect(adopted.session.moved!.rowTs).toBe(session.moved!.rowTs);
  expect(adopted.session.motion.heldUntil).toBe(at);
  // The first leg's stop is not an end: the drive ends 5 min after the new start at the earliest.
  const engine = createEngine({
    now: () => at,
    newId: () => 'x',
    limits: { lookup, prefetch: () => {} },
    createDetectors: () => createDetectors(() => 'y'),
    ctx: () => ({ platform: 'ios' }),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async () => {},
    onCancel: async () => {},
  });
  await engine.dispatch({ type: 'adopt', trip: adopted, ts: at });
  expect(engine.snapshot().autoEndAt).toBe(at + 300_000);
  const leg = rows(10, { t0: at }).map((r, i) => ({ ...r, lng: end.lng + (i * 15) / M_PER_DEG_LNG }));
  for (const r of leg) await engine.dispatch({ type: 'row', row: r });
  expect(engine.snapshot().status).toBe('recording');
  // Nothing to continue any more.
  expect(await continuationFor(db, at + 30_000, end)).toBeNull();
});

test('a re-open refused (the upload was claimed meanwhile) changes nothing and answers null', async () => {
  const { finalizedAt, end } = await firstLeg();
  const c = (await continuationFor(db, finalizedAt + 10_000, end))!;
  await db.execute("UPDATE sync_queue SET status = 'inflight'");
  expect(await reopenTrip(db, c, { ...rebuild, now: finalizedAt + 10_000, at: finalizedAt })).toBeNull();
  expect((await createTripsRepo(db).get(ID))!.status).toBe('pending');
  expect(await createQueueRepo(db).byKey(`trip:${ID}`)).not.toBeNull();
});

test('closeAtLastMovement of the re-opened drive keeps both legs: one drive, its start the first leg’s', async () => {
  const { finalizedAt, end } = await firstLeg();
  const at = finalizedAt + 60_000;
  const adopted = (await reopenTrip(db, (await continuationFor(db, at, end))!, { ...rebuild, now: at, at }))!;
  const s = adopted.session;
  const before = s.distanceM;
  for (const r of rows(60, { t0: at }).map((r, i) => ({ ...r, lng: end.lng + (i * 15) / M_PER_DEG_LNG }))) appendRow(s, r, { unsafe: false, limitUsable: false });
  const closed = closeAtLastMovement(s, 'stopped');
  expect(closed.startedAt).toBe(T0);
  expect(closed.distanceM).toBeGreaterThan(before);
  expect(closed.endedAt).toBe(at + 60_000);
});
