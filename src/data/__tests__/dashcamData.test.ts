/** @jest-environment node */
// The device's data layer with DashPal events: counts kept apart, older stored results still read,
// restored drives with DashPal events, "DashPal got it wrong" queued, and a dispute's local `clean`
// counting phone events only (as the server does).
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { closedSession, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import { finalizeTrip } from '@/core/engine/finalize';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createSettingsRepo, createTripsRepo, DISPUTE_REASONS, migrate, type Db } from '@/data/db';
import { restoreDrives } from '@/data/hydrate/restore';
import { countEvents, parseCounts, parseResult } from '@/data/queries/rows';
import { readRecentDrives } from '@/data/queries/drives';
import { DisputeActionSchema } from '@/data/sync/queue';
import { applyDisputeResult } from '@/data/sync/runner';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const DROWSY = 'dddddddd-0000-4000-8000-000000000001';

test('DashPal events are counted apart from the phone events; an older counts row reads them as 0', () => {
  expect(countEvents([{ type: 'drowsy' }, { type: 'eyes_off' }, { type: 'eyes_off', status: 'removed' }, { type: 'phone_pickup' }])).toMatchObject({
    drowsy: 1,
    eyesOff: 1,
    pickups: 1,
  });
  expect(parseCounts(JSON.stringify({ speeding: 2 }))).toMatchObject({ speeding: 2, eyesOff: 0, drowsy: 0 });
});

test('a result stored before DashPal still parses, as ×1 and the streak multiplier', () => {
  const breakdown = {
    scored: true,
    safeMiles: 5,
    creditedMiles: 5,
    milePoints: 50,
    cleanBonus: 25,
    streakMult: 1.1,
    gains: 83,
    shortScale: 1,
    events: [],
    penalties: 0,
    net: 83,
    ratingPenalty: 0,
    activeEventCount: 0,
  };
  const r = parseResult(
    JSON.stringify({
      tripId: uuid(77),
      clientTripId: uuid(1),
      mergedInto: null,
      scored: true,
      reason: null,
      breakdown,
      net: 83,
      streak: { before: 5, after: 6, outcome: 'grew', nextMult: 1.12, atRisk: false, freezes: 2, freezeEarned: false },
      progress: { points: 1, lifetime: 1, level: 1, levelUp: false, safetyRating: null, ranked: false },
      achievements: [],
      challenges: [],
      league: { tier: 'bronze', placed: true },
    })
  );
  expect(r?.breakdown).toMatchObject({ dashcamMult: 1, mult: 1.1 });
});

test('a restored drive keeps its DashPal event and its DashPal breakdown', async () => {
  const drive = {
    tripId: uuid(101),
    clientTripId: uuid(1),
    startedAt: T0,
    endedAt: T0 + 600_000,
    tz: 'America/Los_Angeles',
    localDay: '2023-11-14',
    miles: 5,
    safeMiles: 5,
    nightMiles: 0,
    durationS: 600,
    polyline: '_p~iF~ps|U',
    dashcamOn: true,
    nDashcam: 1,
    scored: true,
    reason: null,
    notDriving: false,
    clean: true,
    pointsNet: 44,
    breakdown: { scored: true, safeMiles: 5, creditedMiles: 5, milePoints: 50, cleanBonus: 25, streakMult: 1, dashcamMult: 1.25, mult: 1.25, gains: 94, shortScale: 1, events: [{ id: DROWSY, penalty: 50 }], penalties: 50, net: 44, ratingPenalty: 0, activeEventCount: 0 },
    result: null,
    events: [{ id: DROWSY, type: 'drowsy', tier: 'severe', startedAt: T0 + 60_000, durationS: 4, units: null, stoppedInTraffic: null, lat: null, lng: null, measured: { source: 'dashcam', speedMph: 40 }, penalty: 50, status: 'active' }],
  };
  expect(await restoreDrives({ db, uid: 'user-1', rpc: async (_fn, args) => (args?.p_before ? [] : [drive]) })).toMatchObject({ restored: 1 });
  const [d] = await readRecentDrives(db, 1);
  expect(d).toMatchObject({ clean: true, counts: expect.objectContaining({ drowsy: 1, pickups: 0 }) });
  expect(JSON.parse((await createTripsRepo(db).get(uuid(1)))!.breakdown_json!)).toMatchObject({ dashcamMult: 1.25, mult: 1.25 });
  expect(await createEventsRepo(db).listByTrip(uuid(1))).toEqual([expect.objectContaining({ id: DROWSY, type: 'drowsy', penalty: 50 })]);
});

test('"DashPal got it wrong" is a reason the queue accepts', () => {
  expect(DISPUTE_REASONS).toContain('camera_wrong');
  expect(DisputeActionSchema.safeParse({ action: 'dispute', clientTripId: uuid(1), eventId: DROWSY, reason: 'camera_wrong' }).success).toBe(true);
});

test('an accepted dispute leaving only a DashPal event marks the drive clean locally, as the server does', async () => {
  const brake = { id: uuid(2), type: 'hard_brake' as const, tier: 'minor' as const, startedAt: T0 + 300_000, durationS: 1, measured: { peakG: 0.45 } };
  const session = closedSession(1200, [brake], { clientTripId: uuid(10) });
  await finalizeTrip(session, {
    db,
    tz: TZ,
    now: () => T0 + 1_300_000,
    appVersion: '2.0.0',
    geocode: null,
    dashcamFacts: async () => ({
      dashcamId: 'a4c1380f2b7e',
      movingS: 1150,
      coveredS: 1100,
      synced: true,
      events: [{ id: DROWSY, kind: 'drowsy', startedAt: T0 + 600_000, durationS: 4, speedMph: 33 }],
    }),
  });
  await db.execute("UPDATE trips SET status = 'scored'");
  expect((await createTripsRepo(db).get(uuid(10)))?.clean).toBe(0);
  await db.transaction((tx) =>
    applyDisputeResult(tx, { action: 'dispute', clientTripId: uuid(10), eventId: uuid(2), reason: 'hazard' }, { status: 'accepted', rejectReason: null, net: 100, breakdown: null }, T0 + 2_000_000)
  );
  const trip = await createTripsRepo(db).get(uuid(10));
  expect(trip?.clean).toBe(1);
  expect(JSON.parse(trip!.counts_json!)).toMatchObject({ hardBrake: 0, drowsy: 1 });
});
