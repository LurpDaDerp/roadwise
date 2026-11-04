import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';

import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db, DbResult } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb, seedEvents, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { readScoredDrives } from '@/data/queries/analytics';
import { createQueryClient } from '@/data/queries/client';
import { readDriveEvents } from '@/data/queries/drives';
import type { LocalDrive } from '@/data/queries/rows';
import { driveScoreOf } from '@/features/drives/summary';
import { writePlaces } from '@/features/places/model';
import type { SavedPlace } from '@/features/places/model';
import { encodeRuns } from '@/lib/polyline';

import { COMMUTE_SCORE_READ_DRIVES } from '../commuteModel';
import { useCommute } from '../useCommute';

const DAY = 86_400_000;
/** Fri Nov 20 2026, 18:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 18, 0);
const now = () => NOW;
/** 07:40 UTC, `n` days before NOW's day. */
const morning = (n: number) => Date.UTC(2026, 10, 20 - n, 7, 40);

const HOME: SavedPlace = { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.6, lng: -122.3 };
const WORK: SavedPlace = { id: 'work', kind: 'work', name: 'Work', address: '9 Pine St', area: '', lat: 47.62, lng: -122.3 };
const route = encodeRuns([[HOME, WORK].map((p) => ({ lat: p.lat, lng: p.lng }))]);

let db: Db;
let real: Db;
let client: QueryClient;
let eventReads: string[][];

beforeEach(async () => {
  real = await createTestDb();
  eventReads = [];
  db = {
    execute: (sql: string, params?: unknown[]): Promise<DbResult> => {
      if (/FROM trip_events/.test(sql)) eventReads.push(JSON.parse(String(params?.[0] ?? '[]')) as string[]);
      return real.execute(sql, params);
    },
    transaction: (fn) => real.transaction(fn),
  };
  client = createQueryClient();
  const trip = (n: number, startedAt: number, over: Record<string, unknown> = {}) => ({
    client_trip_id: uuid(n),
    started_at: startedAt,
    tz: 'UTC',
    status: 'scored' as const,
    miles: 5,
    duration_s: 20 * 60,
    polyline: route,
    from_place: 'home',
    to_place: 'work',
    slowdowns: 12,
    speedups: 12,
    turns: 10,
    limit_s: 300,
    moving_s: 500,
    ...over,
  });
  await seedTrips(real, [
    trip(1, morning(0)),
    trip(2, morning(3), { duration_s: 30 * 60 }),
    trip(3, morning(7)),
    trip(4, morning(10)),
    // Older than the card's 4 months, a passenger ride, a drive home, a drive elsewhere.
    trip(5, NOW - 121 * DAY),
    trip(6, morning(1), { status: 'not_driving' }),
    trip(7, morning(2), { from_place: 'work', to_place: 'home' }),
    trip(8, morning(4), { from_place: 'home', to_place: null }),
  ]);
  await seedEvents(real, [{ id: uuid(21), client_trip_id: uuid(1), type: 'hard_brake', tier: 'severe', started_at: morning(0) + 60_000 }]);
});

afterEach(async () => {
  await waitFor(() => expect(client.isFetching()).toBe(0));
  client.clear();
});

async function drives(): Promise<LocalDrive[]> {
  return (await readScoredDrives(db, null)).filter((d) => d.archived !== true);
}

test('no saved places: no commute, and no events read for it', async () => {
  const list = await drives();
  const { result } = await renderHook(() => useCommute(list), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(result.current).toEqual([]);
  expect(eventReads.every((ids) => ids.length === 0)).toBe(true);
});

test('the Home → Work leg from the saved places, with the scores of its own drives only', async () => {
  await writePlaces(createSettingsRepo(db), [HOME, WORK]);
  const list = await drives();
  const { result } = await renderHook(() => useCommute(list), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current[0]?.score ?? null).not.toBeNull());
  const [leg] = result.current;
  expect(result.current).toHaveLength(1);
  expect(leg!.id).toBe('home-work');
  expect(leg!.from.name).toBe('Home');
  expect(leg!.to.name).toBe('Work');
  expect(leg!.drives.map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
  expect(leg!.usualS).toBe(20 * 60);
  expect(leg!.departure).toEqual({ minuteOfDay: 7 * 60 + 40, drives: 4 });
  // Only the leg's drives' events are read.
  expect(eventReads.at(-1)!.sort()).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)].sort());
  const events = await readDriveEvents(db, leg!.drives.map((d) => d.clientTripId));
  const scores = leg!.drives.map((d) => driveScoreOf(d, events.get(d.clientTripId) ?? [])!);
  expect(leg!.score).toBe(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
  expect(leg!.scored).toBe(4);
  expect(leg!.change).toBeNull();
});

test('a new list of drives recomputes the rows; the same list keeps them', async () => {
  await writePlaces(createSettingsRepo(db), [HOME, WORK]);
  const list = await drives();
  const { result, rerender } = await renderHook(({ d }: { d: LocalDrive[] }) => useCommute(d), { wrapper: wrapperFor(db, client, now), initialProps: { d: list } });
  await waitFor(() => expect(result.current[0]?.score ?? null).not.toBeNull());
  const first = result.current;
  await act(async () => rerender({ d: list }));
  expect(result.current).toBe(first);
  // Two drives fewer: under the 3 a leg needs.
  await act(async () => rerender({ d: list.filter((d) => d.clientTripId !== uuid(1) && d.clientTripId !== uuid(2)) }));
  await waitFor(() => expect(result.current).toEqual([]));
});

test(`only each leg's newest ${COMMUTE_SCORE_READ_DRIVES} drives are scored, so the read stays the same as old drives age out`, async () => {
  await writePlaces(createSettingsRepo(db), [HOME, WORK]);
  // 20 more Home → Work drives, one a day from 11 to 30 days back.
  await seedTrips(
    real,
    Array.from({ length: 20 }, (_, i) => ({
      client_trip_id: uuid(100 + i),
      started_at: morning(11 + i),
      tz: 'UTC',
      status: 'scored' as const,
      miles: 5,
      duration_s: 20 * 60,
      polyline: route,
      from_place: 'home',
      to_place: 'work',
      slowdowns: 12,
      speedups: 12,
      turns: 10,
      limit_s: 300,
      moving_s: 500,
    }))
  );
  const list = await drives();
  const { result, rerender } = await renderHook(({ d }: { d: LocalDrive[] }) => useCommute(d), { wrapper: wrapperFor(db, client, now), initialProps: { d: list } });
  await waitFor(() => expect(result.current[0]?.score ?? null).not.toBeNull());
  const [leg] = result.current;
  expect(leg!.drives).toHaveLength(24);
  const newest = leg!.drives.slice(0, COMMUTE_SCORE_READ_DRIVES).map((d) => d.clientTripId);
  expect(eventReads.at(-1)!.sort()).toEqual([...newest].sort());
  expect(leg!.scored).toBe(COMMUTE_SCORE_READ_DRIVES);
  expect(leg!.change).not.toBeNull();
  // The oldest drive leaves the list: the same drives are scored, and nothing is read again.
  const reads = eventReads.length;
  await act(async () => rerender({ d: list.filter((d) => d.clientTripId !== uuid(119)) }));
  await waitFor(() => expect(result.current[0]!.drives).toHaveLength(23));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(eventReads.length).toBe(reads);
  expect(result.current[0]!.score).toBe(leg!.score);
});
