import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';

import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db, DbResult } from '@/data/db';
import { createTestDb, seedEvents, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { createQueryClient } from '@/data/queries/client';
import { readDriveDetail, readDriveHistory, type LocalDrive } from '@/data/queries/drives';
import { invalidateAfterSync } from '@/data/queries/invalidate';

import { driveScoreOf } from '../summary';
import { useDriveScores } from '../useDriveScores';

const T0 = 1_700_000_000_000;
const now = () => T0;

let db: Db;
let client: QueryClient;
let eventReads: number;

beforeEach(async () => {
  const real = await createTestDb();
  eventReads = 0;
  db = {
    execute: (sql: string, params?: unknown[]): Promise<DbResult> => {
      if (/FROM trip_events/.test(sql)) eventReads += 1;
      return real.execute(sql, params);
    },
    transaction: (fn) => real.transaction(fn),
  };
  client = createQueryClient();
  const trip = (n: number, over: Record<string, unknown> = {}) => ({
    client_trip_id: uuid(n),
    started_at: T0 - n * 3_600_000,
    tz: 'UTC',
    status: 'scored' as const,
    miles: 6,
    duration_s: 900,
    slowdowns: 10,
    speedups: 10,
    turns: 8,
    limit_s: 400,
    moving_s: 800,
    ...over,
  });
  await seedTrips(real, [
    trip(1),
    trip(2, { status: 'pending' }),
    trip(3),
    trip(4, { status: 'not_driving' }),
    trip(5, { status: 'unscored', reason: 'too_short', miles: 0.1 }),
  ]);
  await seedEvents(real, [
    { id: uuid(21), client_trip_id: uuid(1), type: 'hard_brake', tier: 'severe', started_at: T0 - 3_600_000 + 10 },
    { id: uuid(22), client_trip_id: uuid(1), type: 'speeding', tier: 'moderate', started_at: T0 - 3_600_000 + 20, duration_s: 30, measured_json: '{"speedMph":50,"limitMph":40,"overMphS":200}' },
    { id: uuid(23), client_trip_id: uuid(2), type: 'hard_accel', tier: 'minor', started_at: T0 - 7_200_000 + 5, status: 'removed', dispute_status: 'accepted' },
    { id: uuid(24), client_trip_id: uuid(4), type: 'hard_corner', tier: 'minor', started_at: T0 - 4 * 3_600_000 },
  ]);
});

// Let every read land first, so none re-renders a hook after its test.
afterEach(async () => {
  await waitFor(() => expect(client.isFetching()).toBe(0));
  client.clear();
});

test('one events read for the whole list, and each drive scores as its recap does', async () => {
  const drives = await readDriveHistory(db, 'all');
  eventReads = 0;
  const { result } = await renderHook(() => useDriveScores(drives), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.size).toBe(3));
  expect(eventReads).toBe(1);
  for (const id of [uuid(1), uuid(2), uuid(3)]) {
    const detail = (await readDriveDetail(db, id))!;
    expect(result.current.get(id)).toBe(driveScoreOf(detail.drive, detail.events));
  }
  // Not driving and too short have no score.
  expect(result.current.has(uuid(4))).toBe(false);
  expect(result.current.has(uuid(5))).toBe(false);
});

test('a change refreshes the list’s scores with one read; a drive added to the list waits for its own events', async () => {
  const drives = await readDriveHistory(db, 'all');
  const { result, rerender } = await renderHook(({ list }: { list: LocalDrive[] }) => useDriveScores(list), {
    wrapper: wrapperFor(db, client, now),
    initialProps: { list: drives },
  });
  await waitFor(() => expect(result.current.size).toBe(3));
  eventReads = 0;
  await act(async () => {
    await invalidateAfterSync(client);
  });
  expect(eventReads).toBe(1);
  await seedTrips(db, [{ client_trip_id: uuid(6), started_at: T0 - 600_000, tz: 'UTC', status: 'scored', miles: 3, duration_s: 300 }]);
  await seedEvents(db, [{ id: uuid(26), client_trip_id: uuid(6), type: 'hard_brake', tier: 'severe', started_at: T0 - 590_000 }]);
  const more = await readDriveHistory(db, 'all');
  await rerender({ list: more });
  // While the longer list's events load, the drives already read keep their scores and the new one has none.
  expect(result.current.get(uuid(1))).toBeDefined();
  await waitFor(() => expect(result.current.size).toBe(4));
  const detail = (await readDriveDetail(db, uuid(6)))!;
  expect(result.current.get(uuid(6))).toBe(driveScoreOf(detail.drive, detail.events));
});
