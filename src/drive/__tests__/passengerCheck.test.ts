/** "Are you driving?": every rule, one at a time, and the proof of a paired car's link. */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createTripsRepo, migrate } from '@/data/db';

import {
  PASSENGER_AFTER_DRIVING_MS,
  PASSENGER_MOVING_MPS,
  PASSENGER_PROVEN_MS,
  passengerDue,
  passengerReady,
  readProvenCars,
  type PassengerFacts,
} from '../passengerCheck';

const T = 1_800_000_000_000;

/** Everything holds. */
const due: PassengerFacts = {
  carLink: true,
  origin: 'auto',
  recording: true,
  waiting: false,
  notDrivingAvailable: true,
  pairedCars: 1,
  linkProven: true,
  linkKnown: true,
  pairedEver: false,
  carPlayEver: false,
  audioEver: false,
  audioNow: false,
  droveAt: T,
  rowTs: T + PASSENGER_AFTER_DRIVING_MS,
  rowSpeedMps: PASSENGER_MOVING_MPS,
  appActive: false,
  asked: false,
};

describe('passengerDue', () => {
  test('due when every rule holds', () => {
    expect(passengerDue(due)).toBe(true);
  });

  const breaks: [string, Partial<PassengerFacts>][] = [
    ['no car link build', { carLink: false }],
    ['a Start-card drive', { origin: 'manual' }],
    ['no origin', { origin: null }],
    ['not recording', { recording: false }],
    ['still waiting', { waiting: true }],
    ['"Not driving?" used up', { notDrivingAvailable: false }],
    ['no paired car', { pairedCars: 0 }],
    ['link not proven', { linkProven: false }],
    ['link not read at the open', { linkKnown: false }],
    ['a paired car was on the route', { pairedEver: true }],
    ['CarPlay was on the route', { carPlayEver: true }],
    ['headphones or another car were on the route', { audioEver: true }],
    ['audio on the route now', { audioNow: true }],
    ['never at driving speed', { droveAt: null }],
    ['under 3 minutes at driving speed', { rowTs: T + PASSENGER_AFTER_DRIVING_MS - 1 }],
    ['no trusted speed now', { rowSpeedMps: null }],
    ['slower than 10 mph now', { rowSpeedMps: PASSENGER_MOVING_MPS - 0.01 }],
    ['RoadWise in front', { appActive: true }],
    ['already asked', { asked: true }],
  ];
  test.each(breaks)('never when %s', (_why, over) => {
    expect(passengerDue({ ...due, ...over })).toBe(false);
  });

  test('ready only with Bluetooth known on and notifications allowed', () => {
    expect(passengerReady(due, 'on', true)).toBe(true);
    for (const bt of [null, 'unknown', 'resetting', 'unauthorized', 'off', 'unsupported', 'turning_on', 'turning_off'] as const) expect(passengerReady(due, bt, true)).toBe(false);
    expect(passengerReady(due, 'on', false)).toBe(false);
    expect(passengerReady({ ...due, appActive: true }, 'on', true)).toBe(false);
  });
});

describe('readProvenCars', () => {
  test('a paired car of a kept drive in the last 30 days; not older, not recording, not an unpaired uid', async () => {
    const db = await createSqlJsDb();
    await migrate(db);
    const trips = createTripsRepo(db);
    const add = async (id: string, car: string | null, endedAt: number | null, status: 'scored' | 'recording' | 'not_driving' = 'scored') => {
      await trips.insert({ client_trip_id: id, started_at: (endedAt ?? T) - 600_000, tz: 'UTC', status }, T);
      await db.execute('UPDATE trips SET car_uid = ?, ended_at = ? WHERE client_trip_id = ?', [car, endedAt, id]);
    };
    await add('a', 'civic', T - 1000);
    await add('b', 'rav', T - PASSENGER_PROVEN_MS - 1);
    await add('c', 'rav', null, 'recording');
    await add('d', 'other', T - 1000);
    await add('e', null, T - 1000);
    await add('f', 'van', T - PASSENGER_PROVEN_MS, 'not_driving');
    expect([...(await readProvenCars(db, ['civic', 'rav', 'van'], T))].sort()).toEqual(['civic', 'van']);
    expect([...(await readProvenCars(db, [], T))]).toEqual([]);
  });

  test('a read that fails proves nothing', async () => {
    const db = { execute: async () => Promise.reject(new Error('no such column: car_uid')), transaction: async () => Promise.reject(new Error('x')) };
    expect([...(await readProvenCars(db as never, ['civic'], T))]).toEqual([]);
  });
});
