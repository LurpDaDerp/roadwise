/** @jest-environment node */
// Finalize with the DashPal dashcam's facts (plan §8.4): candidates → scored eyes_off / drowsy
// events under the scoring rules, seconds → the payload's dashcam block, and the estimate derived
// as the server derives it. Edge-case rows 33 (speed, GPS, first 30 s), 35 (phone overlap),
// 36 (per-drive limits) and 37 (no bonus, payload still valid).
import { dashcamDrive, scoreDrive } from '@scoring';

import { T0 } from '@/core/detectors/__fixtures__/rows';
import { closedSession, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import { dashcamBlock, dashcamEvents, finalizeTrip, sanitizeEvent } from '@/core/engine/finalize';
import type { DetectedEvent } from '@/core/engine/types';
import type { DashcamCandidate, DashcamTripFacts } from '@/dashcam/facts';
import { dashcamFinalizeDeps } from '@/dashcam/finalizeDeps';
import { PAIRED_KEY } from '@/dashcam/keys';
import { createDashcamStore } from '@/dashcam/store';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { FinalizeTripPayloadV3Schema } from '@/data/sync/payload';
import { findFinalize } from '@/data/sync/queue';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const TRIP = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'a4c1380f2b7e';
/** Lowercase v4 uuids, as the dashcam store assigns them. */
const cid = (n: number): string => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (s: number): number => T0 + s * 1000;
const cand = (n: number, kind: DashcamCandidate['kind'], s: number, over: Partial<DashcamCandidate> = {}): DashcamCandidate => ({
  id: cid(n),
  kind,
  startedAt: at(s),
  durationS: 4,
  speedMph: 33,
  ...over,
});
const facts = (over: Partial<DashcamTripFacts> = {}): DashcamTripFacts => ({
  dashcamId: DEVICE,
  movingS: 1150,
  coveredS: 1100,
  synced: true,
  events: [],
  ...over,
});
const pickup = (s: number, durationS = 5, id = uuid(30)): DetectedEvent => ({ id, type: 'phone_pickup', tier: 'severe', startedAt: at(s), durationS, measured: {} });

const deps = (dashcamFacts?: (trip: { clientTripId: string; startedAt: number; endedAt: number }) => Promise<DashcamTripFacts>, streak = 0) => ({
  db,
  tz: TZ,
  now: () => T0 + 1_300_000,
  appVersion: '2.0.0',
  geocode: null,
  trimSeed: async (id: string) => `${id}-seed`.padEnd(64, '0'),
  context: async () => ({ streak }),
  ...(dashcamFacts ? { dashcamFacts } : {}),
});

// 1200 rows × 15 m/s (≈ 33.6 mph, 11.2 mi) from T0
const session = (events: DetectedEvent[] = []) => closedSession(1200, events, { clientTripId: TRIP });

describe('finalizeTrip with DashPal facts', () => {
  test('a DashPal drive: the block and the drowsy are uploaded, the estimate takes ×1.25 and keeps the drive clean', async () => {
    // a recording drive with a sample on it, as the engine leaves it
    await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: TZ, local_day: '2023-11-14', status: 'recording' }, T0);
    await createSamplesRepo(db).append(TRIP, T0, { ts: T0 });
    const calls: unknown[] = [];
    const result = await finalizeTrip(
      session(),
      deps(async (trip) => {
        // read before the final transaction purges the samples it needs
        calls.push({ trip, samples: await createSamplesRepo(db).count(TRIP) });
        return facts({ events: [cand(1, 'drowsy', 300, { durationS: 6.5, speedMph: 33.4567 })] });
      }, 10)
    );
    expect(calls).toEqual([{ trip: { clientTripId: TRIP, startedAt: T0, endedAt: T0 + 1_200_000 }, samples: 1 }]);
    expect(await createSamplesRepo(db).count(TRIP)).toBe(0);

    const payload = result.payload!;
    expect(FinalizeTripPayloadV3Schema.safeParse(payload).success).toBe(true);
    expect(payload.dashcam).toEqual({ deviceId: DEVICE, movingS: 1150, coveredS: 1100, synced: true });
    expect(payload.events).toEqual([
      { id: cid(1), type: 'drowsy', tier: 'severe', startedAt: at(300), durationS: 6.5, lat: expect.any(Number), lng: expect.any(Number), measured: { source: 'dashcam', speedMph: 33.457 } },
    ]);
    expect(await findFinalize(db, TRIP)).toEqual(payload);

    expect(result.breakdown).toMatchObject({ streakMult: 1.2, dashcamMult: 1.25, mult: 1.5, cleanBonus: 25, penalties: 50, ratingPenalty: 0, activeEventCount: 0 });
    // the estimate is exactly the server's scoring of what was uploaded
    const server = scoreDrive(
      { miles: payload.miles, safeMiles: payload.safeMiles, events: payload.events, dashcam: dashcamDrive(payload.dashcam) },
      { streak: 10, safeMilesEarlierToday: 0 }
    );
    expect(result.breakdown).toEqual(server);
    expect(result.trip).toMatchObject({ status: 'pending', clean: 1, points_net: server.net });
    expect(JSON.parse(result.trip.counts_json!)).toMatchObject({ drowsy: 1, eyesOff: 0, pickups: 0 });
    expect(result.events).toEqual([expect.objectContaining({ id: cid(1), type: 'drowsy', tier: 'severe', penalty: 50 })]);
    expect(JSON.parse(result.events[0]!.measured_json!)).toEqual({ source: 'dashcam', speedMph: 33.457 });
  });

  test('row 33: a candidate under 10 mph, without a good GPS fix, in the first 30 s or outside the drive is not scored', async () => {
    const result = await finalizeTrip(
      session(),
      deps(async () =>
        facts({
          events: [
            cand(1, 'drowsy', 100, { speedMph: 9.99 }),
            cand(2, 'eyes_off', 200, { speedMph: null }),
            cand(3, 'drowsy', 29.999),
            cand(4, 'eyes_off', 1200.001),
            cand(5, 'drowsy', 400, { startedAt: Number.NaN }),
            cand(6, 'drowsy', 30, { speedMph: 10 }),
          ],
        })
      )
    );
    // only the one at exactly 30 s and exactly 10 mph
    expect(result.payload!.events.map((e) => e.id)).toEqual([cid(6)]);
  });

  test('the warm-up is the drive’s own: a candidate 5 s in is scored when the warm-up ended at 2 s (a start while moving), not on a stopped start', async () => {
    const loader = async () => facts({ events: [cand(1, 'drowsy', 5), cand(2, 'eyes_off', 1)] });
    const moving = { ...session(), warmup: Object.freeze({ continues: false, decided: true, endsAt: at(2) }) };
    expect((await finalizeTrip(moving, deps(loader))).payload!.events.map((e) => e.id)).toEqual([cid(1)]);
    await db.execute('DELETE FROM trips');
    await db.execute('DELETE FROM sync_queue');
    expect((await finalizeTrip(session(), deps(loader))).payload!.events).toEqual([]);
    expect(dashcamEvents([cand(1, 'drowsy', 5)], { startedAt: T0, endedAt: at(100), warmupEndsAt: T0 }, []).map((e) => e.id)).toEqual([cid(1)]);
    expect(dashcamEvents([cand(1, 'drowsy', 5)], { startedAt: T0, endedAt: at(100) }, [])).toEqual([]);
  });

  test('row 35: an eyes-off within 5 s of a phone pickup is dropped (the phone already charged it); a drowsy there is kept', async () => {
    // the pickup spans 600–605 s; ±5 s → 595–610 s
    const result = await finalizeTrip(
      session([pickup(600, 5)]),
      deps(async () =>
        facts({
          events: [
            cand(1, 'eyes_off', 590, { durationS: 5 }), // ends at 595: touches the window
            cand(2, 'eyes_off', 610), // starts at 610: touches it
            cand(3, 'drowsy', 602),
            cand(4, 'eyes_off', 900),
            cand(5, 'eyes_off', 300, { durationS: 294.9 }), // ends at 594.9: clear of it
          ],
        })
      )
    );
    expect(result.payload!.events.map((e) => [e.type, e.id])).toEqual([
      ['eyes_off', cid(5)],
      ['phone_pickup', uuid(30)],
      ['drowsy', cid(3)],
      ['eyes_off', cid(4)],
    ]);
  });

  test('row 36: at most one drowsy per 10 min and one eyes-off per 5 min, the earliest kept', async () => {
    const result = await finalizeTrip(
      session(),
      deps(async () =>
        facts({
          events: [
            cand(1, 'drowsy', 100),
            cand(2, 'drowsy', 400),
            cand(3, 'drowsy', 699.999),
            cand(4, 'drowsy', 700),
            cand(5, 'eyes_off', 60),
            cand(6, 'eyes_off', 200),
            cand(7, 'eyes_off', 360),
            cand(8, 'eyes_off', 361),
            cand(9, 'eyes_off', 1000),
          ],
        })
      )
    );
    expect(result.payload!.events.map((e) => e.id)).toEqual([cid(5), cid(1), cid(7), cid(4), cid(9)]);
    // and the repeat multiplier applies within each type: drowsy 50 + 62.5, eyes-off 40 + 50 + 60
    expect(result.breakdown.events.map((e) => e.penalty)).toEqual([40, 50, 50, 63, 60]);
    expect(result.breakdown.activeEventCount).toBe(0);
  });

  test.each([
    ['coverage under 80 %', facts({ coveredS: 919 })],
    ['under 60 s moving', facts({ movingS: 59, coveredS: 59 })],
    ['not synced at the end', facts({ synced: false })],
  ])('row 37: %s → no bonus, and the payload is still valid and uploaded', async (_why, f) => {
    const result = await finalizeTrip(session(), deps(async () => f));
    expect(result.trip.status).toBe('pending');
    expect(FinalizeTripPayloadV3Schema.safeParse(result.payload).success).toBe(true);
    expect(result.payload!.dashcam).toEqual({ deviceId: DEVICE, movingS: f.movingS, coveredS: f.coveredS, synced: f.synced });
    expect([result.breakdown.dashcamMult, result.breakdown.mult]).toEqual([1, 1]);
  });

  test('no dashcam id (nothing covered): no block, no bonus', async () => {
    const none = await finalizeTrip(session(), deps(async () => facts({ dashcamId: null, movingS: 0, coveredS: 0, synced: false })));
    expect(none.payload).not.toHaveProperty('dashcam');
    expect(none.breakdown.dashcamMult).toBe(1);
  });

  test('events that arrived with no drive open are dropped: the stored facts give the same block, ×1.25 and scored events as without them', async () => {
    const run = async (withIgnored: boolean) => {
      db = await createSqlJsDb();
      await migrate(db);
      await createSettingsRepo(db).set('device.lastUserId', 'user-1');
      await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: DEVICE, peripheralId: 'p-1', name: 'DashPal-7E', pairedAt: 1, secure: true });
      await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: TZ, local_day: '2023-11-14', status: 'recording' }, T0);
      const store = createDashcamStore(db);
      const offset = T0 - 3_600_000; // the dashcam booted an hour before the drive
      await store.ensureBoot(DEVICE, 7, 0);
      await store.offerOffset(DEVICE, 7, offset, 20);
      await store.addCoverage(TRIP, 1150, 1100, T0 + 1_199_000);
      let seq = 0;
      const put = async (s: number, ev: number, detail: number, ignored: boolean) => {
        await db.execute('INSERT INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)', [TRIP, at(s), JSON.stringify({ ts: at(s), speed: 15, gnssValid: true })]);
        await store.insertEvent({
          dashcamId: DEVICE, bootKey: 7, seq, id: cid(100 + seq), ev, name: 'X', tier: 3, audible: true, detail,
          tMs: at(s) - offset, durDs: 20, value: 0, atMs: null, startedAtMs: null, receivedAtMs: at(s) + 50, ignored,
        });
        seq += 1;
      };
      await put(300, 0, 0, false); // a microsleep in the drive
      if (withIgnored) {
        await put(1000, 1, 0, true); // a sleep and an eyes-off, inside the window by time, that arrived with no drive open
        await put(600, 2, 1, true);
      }
      return finalizeTrip(session(), deps(dashcamFinalizeDeps(db).dashcamFacts));
    };
    const plain = await run(false);
    const result = await run(true);
    expect(result.payload!.dashcam).toEqual({ deviceId: DEVICE, movingS: 1150, coveredS: 1100, synced: true });
    expect(result.breakdown.dashcamMult).toBe(1.25);
    expect(result.payload!.events.map((e) => [e.id, e.type])).toEqual([[cid(100), 'drowsy']]);
    expect(result.payload!.dashcam).toEqual(plain.payload!.dashcam);
    expect(result.breakdown).toEqual(plain.breakdown);
    expect((await db.execute('SELECT seq, client_trip_id FROM dashcam_events ORDER BY seq')).rows).toEqual([
      { seq: 0, client_trip_id: TRIP },
      { seq: 1, client_trip_id: null },
      { seq: 2, client_trip_id: null },
    ]);
  });

  test('a drive cut at its last movement: an alert 10 s after the cut is not claimed (and not ignored), one 10 s before is; synced is judged at the cut', async () => {
    const run = async (lastSyncedS: number) => {
      db = await createSqlJsDb();
      await migrate(db);
      await createSettingsRepo(db).set('device.lastUserId', 'user-1');
      await createSettingsRepo(db).set(PAIRED_KEY, { dashcamId: DEVICE, peripheralId: 'p-1', name: 'DashPal-7E', pairedAt: 1, secure: true });
      await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: TZ, local_day: '2023-11-14', status: 'recording' }, T0);
      const store = createDashcamStore(db);
      const offset = T0 - 3_600_000;
      await store.ensureBoot(DEVICE, 7, 0);
      await store.offerOffset(DEVICE, 7, offset, 20);
      await store.addCoverage(TRIP, 900, 880, at(lastSyncedS));
      let seq = 0;
      for (const sec of [990, 1010]) {
        await db.execute('INSERT INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)', [TRIP, at(sec), JSON.stringify({ ts: at(sec), speed: 15, gnssValid: true })]);
        await store.insertEvent({
          dashcamId: DEVICE, bootKey: 7, seq, id: cid(200 + seq), ev: 0, name: 'X', tier: 3, audible: true, detail: 0,
          tMs: at(sec) - offset, durDs: 20, value: 0, atMs: null, startedAtMs: null, receivedAtMs: at(sec) + 50, ignored: false,
        });
        seq += 1;
      }
      // The engine closed the drive at its last movement, 1000 s in (the tail after it is left out).
      const cut = { ...session(), endedAt: at(1000), cut: true };
      return finalizeTrip(cut, deps(dashcamFinalizeDeps(db).dashcamFacts));
    };
    const result = await run(975);
    expect(result.payload!.endedAt).toBe(at(1000));
    expect(result.payload!.events.map((e) => [e.id, e.type])).toEqual([[cid(200), 'drowsy']]);
    expect(result.payload!.dashcam).toMatchObject({ synced: true });
    expect((await db.execute('SELECT seq, client_trip_id, ignored FROM dashcam_events ORDER BY seq')).rows).toEqual([
      { seq: 0, client_trip_id: TRIP, ignored: 0 },
      { seq: 1, client_trip_id: null, ignored: 0 },
    ]);
    expect((await run(965)).payload!.dashcam).toMatchObject({ synced: false });
  });

  test('a loader that throws leaves the drive a plain one', async () => {
    const result = await finalizeTrip(session(), deps(async () => Promise.reject(new Error('db busy'))));
    expect(result.trip.status).toBe('pending');
    expect(result.payload).not.toHaveProperty('dashcam');
  });

  test('without the dependency the payload carries no dashcam block', async () => {
    const result = await finalizeTrip(session(), deps());
    expect(result.payload).not.toHaveProperty('dashcam');
    expect(result.payload!.events).toEqual([]);
  });
});

describe('dashcamBlock', () => {
  test('whole seconds clamped into the contract; the id lowercased; a bad id means no block', () => {
    expect(dashcamBlock(facts({ movingS: 100.9, coveredS: 99.99 }))).toEqual({ deviceId: DEVICE, movingS: 100, coveredS: 99, synced: true });
    expect(dashcamBlock(facts({ movingS: 50_000, coveredS: 60_000 }))).toEqual({ deviceId: DEVICE, movingS: 43_200, coveredS: 43_200, synced: true });
    expect(dashcamBlock(facts({ movingS: 100, coveredS: 120 }))?.coveredS).toBe(100);
    expect(dashcamBlock(facts({ movingS: Number.NaN, coveredS: -5 }))).toEqual({ deviceId: DEVICE, movingS: 0, coveredS: 0, synced: true });
    expect(dashcamBlock(facts({ dashcamId: 'A4C1380F2B7E' }))?.deviceId).toBe(DEVICE);
    expect(dashcamBlock(facts({ dashcamId: 'a4:c1:38:0f:2b:7e' }))).toBeNull();
    expect(dashcamBlock(facts({ dashcamId: null }))).toBeNull();
    expect(dashcamBlock(null)).toBeNull();
  });
});

describe('dashcamEvents', () => {
  const trip = { startedAt: T0, endedAt: T0 + 1_200_000 };
  test('a candidate id the contract or the server would refuse, or one already on the drive, is dropped', () => {
    const out = dashcamEvents(
      [
        cand(1, 'drowsy', 100, { id: 'DDDDDDDD-0000-4000-8000-000000000001' }),
        cand(2, 'drowsy', 200, { id: 'not-a-uuid' }),
        cand(3, 'eyes_off', 300, { id: uuid(40) }),
        cand(4, 'eyes_off', 400, { id: cid(9) }),
        cand(5, 'eyes_off', 401, { id: cid(9) }),
      ],
      trip,
      [{ id: uuid(40), type: 'hard_brake', startedAt: at(50), durationS: 1 }]
    );
    expect(out.map((e) => e.id)).toEqual([cid(9)]);
  });

  test('a removed phone event does not drop an eyes-off', () => {
    const out = dashcamEvents([cand(1, 'eyes_off', 600)], trip, [{ ...pickup(600), status: 'removed' }]);
    expect(out).toHaveLength(1);
  });

  test('phone handling counts as phone use for the overlap', () => {
    const handling = { id: uuid(31), type: 'phone_handling' as const, startedAt: at(500), durationS: 60 };
    expect(dashcamEvents([cand(1, 'eyes_off', 540)], trip, [handling])).toEqual([]);
  });
});

test('sanitizeEvent keeps source dashcam on a DashPal event, adds it when missing and strips it from a phone event', () => {
  const drowsy: DetectedEvent = { id: cid(1), type: 'drowsy', tier: 'severe', startedAt: at(100), durationS: 4, measured: { speedMph: 30 } };
  expect(sanitizeEvent(drowsy, T0, T0 + 1_200_000).measured).toEqual({ speedMph: 30, source: 'dashcam' });
  const brake: DetectedEvent = { id: uuid(2), type: 'hard_brake', tier: 'minor', startedAt: at(100), durationS: 1, measured: { peakG: 0.4, source: 'dashcam' } };
  expect(sanitizeEvent(brake, T0, T0 + 1_200_000).measured).toEqual({ peakG: 0.4 });
});
