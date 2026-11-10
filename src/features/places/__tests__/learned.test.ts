/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate, type Db } from '@/data/db';

import { MAX_TRIPS, readTripEnds } from '../learned';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

async function insertDrives(count: number, firstStart: number, stepMs: number): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < count; i += 1) {
      const started = firstStart + i * stepMs;
      await tx.execute(
        `INSERT INTO trips (client_trip_id, started_at, ended_at, tz, status, start_lat, start_lng, end_lat, end_lng, created_at, updated_at)
         VALUES (?, ?, ?, 'UTC', 'scored', 40.1, -74.1, 40.2, -74.2, ?, ?)`,
        [`trip-${String(i).padStart(5, '0')}`, started, started + 600_000, started, started]
      );
    }
  });
}

test('past the cap the newest drives are read, oldest first', async () => {
  const step = 60_000;
  const first = NOW - 30 * DAY_MS;
  await insertDrives(MAX_TRIPS + 5, first, step);
  const ends = await readTripEnds(db, NOW);
  expect(ends).toHaveLength(MAX_TRIPS);
  // The five oldest fall away; the newest is kept.
  expect(ends[0]!.id).toBe('trip-00005');
  expect(ends[ends.length - 1]!.id).toBe(`trip-${String(MAX_TRIPS + 4).padStart(5, '0')}`);
  for (let i = 1; i < ends.length; i += 1) expect(ends[i]!.startedAt).toBeGreaterThan(ends[i - 1]!.startedAt);
  expect(ends[0]).toMatchObject({ start: { lat: 40.1, lng: -74.1 }, end: { lat: 40.2, lng: -74.2 }, tz: 'UTC' });
});
