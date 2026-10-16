/** @jest-environment node */
// A rebuilt drive charges screen switches exactly as the live one did (design §6.4, §12.3 item 12):
// with the drive's own stored signal; with none when it was not kept; and on iPhone no motion during
// a call, from the rows' own call key.
import { createDetectors } from '@/core/detectors';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import type { PhoneSwitchCtx } from '@/core/detectors/phoneSwitch';
import { rows, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import type { TripSession } from '@/core/engine/engine.types';
import { recoverRecordingTrips } from '@/core/engine/recovery';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSamplesRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { phoneSwitchFor, writePhoneSwitch } from '@/drive/phoneSwitchStore';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

async function orphan(id: string, list: FeatureRow[]): Promise<void> {
  const trips = createTripsRepo(db);
  await trips.insert({ client_trip_id: id, started_at: T0, tz: TZ, status: 'recording' }, T0);
  await createSamplesRepo(db).appendMany(id, list.map((r) => ({ ts: r.ts, row: r })));
  await trips.checkpoint(id, list.at(-1)!.ts);
}

async function recover(id: string, deps: { phoneSwitch?: (id: string) => Promise<PhoneSwitchCtx | null>; platform?: 'ios' | 'android' }) {
  const finalized: Readonly<TripSession>[] = [];
  await recoverRecordingTrips(db, {
    createDetectors: () => createDetectors(() => 'x'),
    limits: { lookup: () => null },
    now: () => T0 + 600_000,
    adoptable: async () => false,
    finalize: async (s) => {
      finalized.push(s);
      await createTripsRepo(db).update(s.clientTripId, { status: 'pending' });
      return 'finalized' as const;
    },
    phoneSwitch: deps.phoneSwitch ? (trip) => deps.phoneSwitch!(trip.client_trip_id) : undefined,
    platform: deps.platform,
  });
  return finalized.find((s) => s.clientTripId === id)!;
}

const front = { locked: false, screenOn: true, appForeground: true };
const away = { locked: false, screenOn: true, appForeground: false };
/** 60 s driving, 20 s in another app, 40 s back in RoadWise. */
const switchDrive = () => rows(120, { over: (i) => (i >= 60 && i < 80 ? away : front) });

test('an orphan whose rows carry a switch is finalized with the same pickup when its key reads reliable', async () => {
  await orphan(uuid(1), switchDrive());
  await writePhoneSwitch(db, { clientTripId: uuid(1), signal: 'reliable', lockDelayMs: null, leave: null });
  const s = await recover(uuid(1), { phoneSwitch: (id) => phoneSwitchFor(db, id) });
  expect(s.events.filter((e) => e.type === 'phone_pickup')).toEqual([expect.objectContaining({ startedAt: T0 + 60_000, durationS: 20 })]);
});

test("with no key, or another drive's, the rebuild counts no switch", async () => {
  await orphan(uuid(1), switchDrive());
  expect((await recover(uuid(1), { phoneSwitch: (id) => phoneSwitchFor(db, id) })).events).toEqual([]);
  await orphan(uuid(2), switchDrive());
  await writePhoneSwitch(db, { clientTripId: uuid(9), signal: 'reliable', lockDelayMs: null, leave: null });
  expect((await recover(uuid(2), { phoneSwitch: (id) => phoneSwitchFor(db, id) })).events).toEqual([]);
});

test('the rows stamped exempt stay exempt in the rebuild', async () => {
  await orphan(uuid(1), rows(120, { over: (i) => (i >= 60 && i < 80 ? { ...away, exempt: 'nav' } : front) }));
  await writePhoneSwitch(db, { clientTripId: uuid(1), signal: 'reliable', lockDelayMs: null, leave: null });
  expect((await recover(uuid(1), { phoneSwitch: (id) => phoneSwitchFor(db, id) })).events).toEqual([]);
});

test('an iPhone orphan whose rows carry a live call and handling gets no pickup; on Android the same rows do', async () => {
  const handledInCall = () => rows(120, { over: (i) => (i >= 60 && i < 70 ? { ...front, handlingScore: 0.9, gravityStability: 0.6, orientationDelta: 0.2, call: 'live' as const } : front) });
  await orphan(uuid(1), handledInCall());
  expect((await recover(uuid(1), { platform: 'ios' })).events).toEqual([]);
  await orphan(uuid(2), handledInCall());
  const android = await recover(uuid(2), { platform: 'android' });
  expect(android.events.filter((e) => e.type === 'phone_pickup')).toHaveLength(1);
});

test('a stored value this build cannot read is no value (the rebuild then counts no switch)', async () => {
  const { parseStoredPhoneSwitch } = jest.requireActual<typeof import('@/drive/phoneSwitchStore')>('@/drive/phoneSwitchStore');
  const good = { clientTripId: uuid(1), signal: 'lagged', lockDelayMs: 10_400, leave: { sinceRowTs: T0, left: true } };
  expect(parseStoredPhoneSwitch(good)).toEqual(good);
  expect(parseStoredPhoneSwitch({ ...good, leave: null, lockDelayMs: null })).toEqual({ ...good, leave: null, lockDelayMs: null });
  for (const bad of [null, 'x', { ...good, signal: 'maybe' }, { ...good, clientTripId: 1 }, { ...good, lockDelayMs: -1 }, { ...good, leave: { sinceRowTs: 'x', left: true } }, { ...good, leave: { sinceRowTs: null } }]) {
    expect(parseStoredPhoneSwitch(bad)).toBeNull();
  }
});
