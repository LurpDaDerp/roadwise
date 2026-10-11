/** @jest-environment node */
import { z } from 'zod';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';

import { episodes, type EpisodeEvent } from '../episodes';
import { loadDashcamTripFacts } from '../facts';
import { PAIRED_KEY } from '../keys';
import { createDashcamStore } from '../store';

const CAM = 'a4cf12b3c4d5';
const OTHER = '0000000000ff';
const TRIP = '11111111-1111-4111-8111-111111111111';
const TRIP2 = '22222222-2222-4222-8222-222222222222';
const T0 = 1_791_600_000_000;
/** dashcam uptime 0 = epoch T0 - 3_600_000 (booted an hour before the drive) */
const OFFSET = T0 - 3_600_000;
const uptimeAt = (epoch: number) => epoch - OFFSET;
const MPH = 0.44704;

let db: Db;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  n = 0;
  await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: CAM, peripheralId: 'p-1', name: 'DashPal-C4D5', pairedAt: 1 });
  const store = createDashcamStore(db);
  await store.ensureBoot(CAM, 7, 0);
  await store.offerOffset(CAM, 7, OFFSET, 20);
});

/** An event that fired at `firedAt` (epoch) after `durS` seconds of its condition. */
async function event(o: { seq: number; ev: number; detail?: number; firedAt: number; durS?: number; audible?: boolean; dashcam?: string; boot?: number; trip?: string | null }) {
  const id = uuid();
  await createDashcamStore(db).insertEvent({
    dashcamId: o.dashcam ?? CAM,
    bootKey: o.boot ?? 7,
    seq: o.seq,
    id,
    ev: o.ev,
    name: 'X',
    tier: 3,
    audible: o.audible ?? true,
    detail: o.detail ?? 0,
    tMs: uptimeAt(o.firedAt),
    durDs: Math.round((o.durS ?? 1) * 10),
    value: 0,
    atMs: null,
    startedAtMs: null,
    receivedAtMs: o.firedAt + 50,
  });
  if (o.trip !== undefined) await db.execute('UPDATE dashcam_events SET client_trip_id = ? WHERE id = ?', [o.trip, id]);
  return id;
}

async function sample(ts: number, speedMps: number, gnssValid = true) {
  await db.execute('INSERT INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)', [TRIP, ts, JSON.stringify({ ts, speed: speedMps, gnssValid })]);
}

const trip = { clientTripId: TRIP, startedAt: T0, endedAt: T0 + 30 * 60_000 };

test('no pairing, no coverage: nothing (the stub contract)', async () => {
  await createSettingsRepo(db).remove(PAIRED_KEY);
  expect(await loadDashcamTripFacts(db, trip)).toEqual({ dashcamId: null, movingS: 0, coveredS: 0, synced: false, events: [] });
});

test('coverage seconds, the synced rule (within 30 s of the end) and the dashcam id only when the drive moved', async () => {
  const store = createDashcamStore(db);
  expect((await loadDashcamTripFacts(db, trip)).dashcamId).toBeNull();
  await store.addCoverage(TRIP, 1, 1, null);
  await store.addCoverage(TRIP, 1, 0, trip.endedAt - 30_001);
  let f = await loadDashcamTripFacts(db, trip);
  expect(f).toMatchObject({ dashcamId: CAM, movingS: 2, coveredS: 1, synced: false });
  await store.addCoverage(TRIP, 0, 0, trip.endedAt - 30_000);
  f = await loadDashcamTripFacts(db, trip);
  expect(f.synced).toBe(true);
  // A later row with no sync stamp keeps the last one.
  await store.addCoverage(TRIP, 1, 1, null);
  expect(await loadDashcamTripFacts(db, trip)).toMatchObject({ movingS: 3, coveredS: 2, synced: true });
});

test('row 34: microsleep → sleep → unresponsive within 60 s is ONE drowsy candidate; D4 then F3 is ONE eyes_off', async () => {
  await createDashcamStore(db).addCoverage(TRIP, 600, 600, null);
  const a = T0 + 5 * 60_000;
  const first = await event({ seq: 0, ev: 0, firedAt: a, durS: 1.5 });
  await event({ seq: 1, ev: 1, firedAt: a + 20_000, durS: 4 });
  await event({ seq: 2, ev: 2, detail: 2, firedAt: a + 50_000, durS: 10 });
  const b = T0 + 15 * 60_000;
  const d4 = await event({ seq: 3, ev: 2, detail: 1, firedAt: b, durS: 5 });
  await event({ seq: 4, ev: 2, detail: 3, firedAt: b + 30_000, durS: 3 });
  await sample(a - 1000, 20 * MPH);
  await sample(b, 30 * MPH);

  const f = await loadDashcamTripFacts(db, trip);
  expect(f.events).toEqual([
    { id: first, kind: 'drowsy', startedAt: a - 1500, durationS: 51.5, speedMph: expect.closeTo(20, 6) },
    { id: d4, kind: 'eyes_off', startedAt: b - 5000, durationS: 35, speedMph: expect.closeTo(30, 6) },
  ]);
  // Every candidate id passes the upload contract's uuid rule and the SQL lowercase rule.
  for (const e of f.events) {
    expect(z.uuid().safeParse(e.id).success).toBe(true);
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('an F3 alone never starts an episode; a D4 with drowsy evidence in the same episode is drowsy', async () => {
  const a = T0 + 2 * 60_000;
  await event({ seq: 0, ev: 2, detail: 3, firedAt: a });
  const b = T0 + 10 * 60_000;
  const d4 = await event({ seq: 1, ev: 2, detail: 1, firedAt: b });
  await event({ seq: 2, ev: 0, firedAt: b + 59_000, durS: 1 });
  const f = await loadDashcamTripFacts(db, trip);
  expect(f.events.map((e) => [e.id, e.kind])).toEqual([[d4, 'drowsy']]);
});

test('events 61 s apart are two episodes; non-audible and non-critical events are never candidates', async () => {
  const a = T0 + 2 * 60_000;
  await event({ seq: 0, ev: 0, firedAt: a, durS: 1 });
  await event({ seq: 1, ev: 0, firedAt: a + 62_000, durS: 1 }); // starts 61 s after the first fired
  await event({ seq: 2, ev: 0, firedAt: a + 300_000, audible: false });
  await event({ seq: 3, ev: 3, firedAt: a + 400_000 }); // LONG_GLANCE
  await event({ seq: 4, ev: 99, firedAt: a + 500_000 }); // unknown id
  const f = await loadDashcamTripFacts(db, trip);
  expect(f.events).toHaveLength(2);
  expect(f.events.every((e) => e.kind === 'drowsy')).toBe(true);
});

test('CRITICAL_STAND_DOWN (ev 31, detail face_gone) is log only: stamped to the drive, never a candidate, never extends an episode', async () => {
  const a = T0 + 4 * 60_000;
  const sleep = await event({ seq: 0, ev: 1, firedAt: a, durS: 2 });
  // The critical stood down 30 s after the face went (tier 0, not audible on the wire); even if it
  // arrived marked audible it must not count.
  const standDown = await event({ seq: 1, ev: 31, detail: 5, firedAt: a + 40_000, durS: 30, audible: false });
  await event({ seq: 2, ev: 31, detail: 5, firedAt: T0 + 20 * 60_000, durS: 30, audible: true });
  const f = await loadDashcamTripFacts(db, trip);
  expect(f.events).toEqual([{ id: sleep, kind: 'drowsy', startedAt: a - 2000, durationS: 2, speedMph: null }]);
  const { rows } = await db.execute('SELECT client_trip_id, name FROM dashcam_events WHERE id = ?', [standDown]);
  expect(rows[0]).toMatchObject({ client_trip_id: TRIP });
  expect(episodes([{ id: 'x', ev: 31, detail: 5, startedAt: 0, firedAt: 30_000 }])).toEqual([]);
});

test('window selection: the derived start must be inside the drive; other dashcams, boots without an offset and events another drive claimed are left alone', async () => {
  await event({ seq: 0, ev: 0, firedAt: T0 + 500, durS: 1 }); // starts 500 ms before the drive
  const inside = await event({ seq: 1, ev: 0, firedAt: T0 + 1500, durS: 1 }); // starts at T0 + 500
  await event({ seq: 2, ev: 0, firedAt: trip.endedAt + 1000, durS: 2 }); // starts 1 s before the end → inside
  await event({ seq: 3, ev: 0, firedAt: trip.endedAt + 2000, durS: 1 }); // starts 1 s after the end
  await createDashcamStore(db).ensureBoot(OTHER, 7, 0);
  await createDashcamStore(db).offerOffset(OTHER, 7, OFFSET, 10);
  await event({ seq: 0, ev: 0, firedAt: T0 + 9 * 60_000, dashcam: OTHER });
  await createDashcamStore(db).ensureBoot(CAM, 8, 0); // a boot never time-synced
  await event({ seq: 0, ev: 0, firedAt: T0 + 9 * 60_000, boot: 8 });
  await createTripsRepo(db).insert({ client_trip_id: TRIP2, started_at: T0, tz: 'UTC', status: 'scored' }, T0);
  await event({ seq: 5, ev: 0, firedAt: T0 + 20 * 60_000, trip: TRIP2 });

  const f = await loadDashcamTripFacts(db, trip);
  expect(f.events.map((e) => e.id)).toEqual([inside, expect.any(String)]);
  expect(f.events[1]!.startedAt).toBe(trip.endedAt - 1000);

  // The in-drive events are stamped to this drive with the wall-time cache; the rest are untouched.
  const { rows } = await db.execute('SELECT dashcam_id, boot_id, seq, client_trip_id, started_at_ms FROM dashcam_events ORDER BY dashcam_id, boot_id, seq');
  expect(rows).toEqual([
    { dashcam_id: OTHER, boot_id: 7, seq: 0, client_trip_id: null, started_at_ms: null },
    { dashcam_id: CAM, boot_id: 7, seq: 0, client_trip_id: null, started_at_ms: null },
    { dashcam_id: CAM, boot_id: 7, seq: 1, client_trip_id: TRIP, started_at_ms: T0 + 500 },
    { dashcam_id: CAM, boot_id: 7, seq: 2, client_trip_id: TRIP, started_at_ms: trip.endedAt - 1000 },
    { dashcam_id: CAM, boot_id: 7, seq: 3, client_trip_id: null, started_at_ms: null },
    { dashcam_id: CAM, boot_id: 7, seq: 5, client_trip_id: TRIP2, started_at_ms: null },
    { dashcam_id: CAM, boot_id: 8, seq: 0, client_trip_id: null, started_at_ms: null },
  ]);
  // Idempotent: the same facts again (finalize retried with the same closed session).
  expect((await loadDashcamTripFacts(db, trip)).events.map((e) => e.id)).toEqual(f.events.map((e) => e.id));
});

test('wall times use the best offset at load time, not the receipt-time cache', async () => {
  const id = await event({ seq: 0, ev: 0, firedAt: T0 + 60_000, durS: 1 });
  // A better TIME_PING sample later moved the offset by +700 ms.
  await createDashcamStore(db).offerOffset(CAM, 7, OFFSET + 700, 5);
  const f = await loadDashcamTripFacts(db, trip);
  expect(f.events).toEqual([expect.objectContaining({ id, startedAt: T0 + 60_000 - 1000 + 700 })]);
});

test('the GNSS rule: the nearest valid-fix row within ±2 s of the first event fire time, else null', async () => {
  const a = T0 + 5 * 60_000;
  await event({ seq: 0, ev: 0, firedAt: a });
  await sample(a, 50 * MPH, false); // nearest, but no fix
  await sample(a + 1000, -1); // unknown speed
  await sample(a - 2000, 12 * MPH); // valid, at the edge
  await sample(a + 2001, 70 * MPH); // outside
  expect((await loadDashcamTripFacts(db, trip)).events[0]!.speedMph).toBeCloseTo(12, 6);

  const b = T0 + 20 * 60_000;
  await event({ seq: 1, ev: 0, firedAt: b });
  await sample(b + 2500, 40 * MPH);
  expect((await loadDashcamTripFacts(db, trip)).events[1]!.speedMph).toBeNull();
});

test('episodes(): order-independent; an F3 within 60 s joins and extends, never starts', () => {
  const e = (id: string, ev: number, detail: number, start: number, fired: number): EpisodeEvent => ({ id, ev, detail, startedAt: start, firedAt: fired });
  const list = [e('c', 2, 3, 70_000, 75_000), e('a', 0, 0, 0, 1_000), e('b', 2, 1, 20_000, 25_000)];
  expect(episodes(list)).toEqual([{ first: list[1], kind: 'drowsy', startedAt: 0, endedAt: 75_000 }]);
  expect(episodes([e('x', 2, 3, 0, 1000)])).toEqual([]);
  expect(episodes([e('x', 2, 3, 0, 1000), e('y', 2, 1, 30_000, 31_000)])).toEqual([
    { first: expect.objectContaining({ id: 'y' }), kind: 'eyes_off', startedAt: 30_000, endedAt: 31_000 },
  ]);
});
