/** @jest-environment node */
// The device's data layer with DashPal events: counts kept apart, restored drives with DashPal
// events, "DashPal got it wrong" queued, and a dispute's local `clean` taken from the server, which
// counts the phone's events only.
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createSettingsRepo, createTripsRepo, DISPUTE_REASONS, migrate, type Db } from '@/data/db';
import { restoreDrives } from '@/data/hydrate/restore';
import { countEvents, parseCounts } from '@/data/queries/rows';
import { readRecentDrives } from '@/data/queries/drives';
import { finishedDrive, T0, uuid } from '@/data/sync/__fixtures__/drives';
import { DisputeActionSchema } from '@/data/sync/queue';
import { applyDisputeResult } from '@/data/sync/runner';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const DROWSY = 'dddddddd-0000-4000-8000-000000000001';

test('DashPal events are counted apart from the phone’s events (active pickups among them); an older counts row reads them as 0', () => {
  expect(
    countEvents([{ type: 'drowsy' }, { type: 'eyes_off' }, { type: 'eyes_off', status: 'removed' }, { type: 'hard_brake' }, { type: 'phone_pickup' }, { type: 'phone_pickup', status: 'removed' }])
  ).toEqual({
    speeding: 0,
    hardBrake: 1,
    hardAccel: 0,
    hardCorner: 0,
    pickups: 1,
    drowsy: 1,
    eyesOff: 1,
  });
  expect(parseCounts(JSON.stringify({ speeding: 2 }))).toMatchObject({ speeding: 2, pickups: 0, eyesOff: 0, drowsy: 0 });
  expect(parseCounts(JSON.stringify({ pickups: 2 }))).toMatchObject({ pickups: 2 });
});

test('a restored drive keeps its DashPal event and stays clean', async () => {
  const drive = {
    tripId: uuid(101),
    clientTripId: uuid(1),
    startedAt: T0,
    endedAt: T0 + 600_000,
    tz: 'America/Los_Angeles',
    localDay: '2023-11-14',
    miles: 5,
    nightMiles: 0,
    durationS: 600,
    polyline: '_p~iF~ps|U',
    dashcamOn: true,
    nDashcam: 1,
    dashcamMovingS: 580,
    dashcamCoveredS: 580,
    scored: true,
    reason: null,
    notDriving: false,
    clean: true,
    result: null,
    events: [{ id: DROWSY, type: 'drowsy', tier: 'severe', startedAt: T0 + 60_000, durationS: 4, lat: null, lng: null, measured: { source: 'dashcam', speedMph: 40 }, status: 'active' }],
  };
  // The restore's clock is the drive's day: a drive past 183 days would come down archived (in no list).
  expect(await restoreDrives({ db, uid: 'user-1', now: () => T0 + 600_000, rpc: async (_fn, args) => (args?.p_before ? [] : [drive]) })).toMatchObject({ restored: 1 });
  const [d] = await readRecentDrives(db, 1);
  expect(d).toMatchObject({ clean: true, watchedMiles: 5, counts: expect.objectContaining({ drowsy: 1, speeding: 0 }) });
  expect(await createEventsRepo(db).listByTrip(uuid(1))).toEqual([expect.objectContaining({ id: DROWSY, type: 'drowsy', measured_json: '{"source":"dashcam","speedMph":40}' })]);
});

test('"DashPal got it wrong" and "My phone was mounted" are reasons the queue accepts', () => {
  expect(DISPUTE_REASONS).toEqual(['hazard', 'wrong_limit', 'mounted', 'camera_wrong']);
  expect(DisputeActionSchema.safeParse({ action: 'dispute', clientTripId: uuid(1), eventId: DROWSY, reason: 'camera_wrong' }).success).toBe(true);
  expect(DisputeActionSchema.safeParse({ action: 'dispute', clientTripId: uuid(1), eventId: DROWSY, reason: 'mounted' }).success).toBe(true);
  expect(DisputeActionSchema.safeParse({ action: 'dispute', clientTripId: uuid(1), eventId: DROWSY, reason: 'pocket' }).success).toBe(false);
});

test('an accepted dispute leaving only a DashPal event marks the scored drive clean, as the server answers', async () => {
  await finishedDrive(db, uuid(10), {
    events: [
      { id: uuid(2), type: 'hard_brake', tier: 'minor', startedAt: T0 + 300_000, durationS: 1, lat: null, lng: null, measured: { peakG: 0.45 } },
      { id: DROWSY, type: 'drowsy', tier: 'severe', startedAt: T0 + 600_000, durationS: 4, lat: null, lng: null, measured: { source: 'dashcam', speedMph: 33 } },
    ],
  });
  await db.execute("UPDATE trips SET status = 'scored'");
  expect((await createTripsRepo(db).get(uuid(10)))?.clean).toBe(0);
  await db.transaction((tx) =>
    applyDisputeResult(tx, { action: 'dispute', clientTripId: uuid(10), eventId: uuid(2), reason: 'hazard' }, { status: 'accepted', rejectReason: null, clean: true }, T0 + 2_000_000)
  );
  const trip = await createTripsRepo(db).get(uuid(10));
  expect(trip?.clean).toBe(1);
  expect(JSON.parse(trip!.counts_json!)).toMatchObject({ hardBrake: 0, drowsy: 1 });
});
