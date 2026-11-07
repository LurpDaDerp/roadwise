import { renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';

import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { readScoredDrives, useScoredDrives } from '@/data/queries/analytics';
import { createQueryClient } from '@/data/queries/client';
import { queryKeys } from '@/data/queries/keys';
import { writePlaces, type SavedPlace } from '@/features/places/model';
import { usePlaces } from '@/features/places/usePlaces';

import type { LocalDrive } from '../model';
import { useCommuteCompare } from '../useCommuteCompare';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Fri Nov 20 2026, 18:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 18, 0);
const now = () => NOW;
/** 07:40 UTC, `n` days before NOW's day. */
const morning = (n: number) => Date.UTC(2026, 10, 20 - n, 7, 40);

const HOME: SavedPlace = { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.6, lng: -122.3 };
const WORK: SavedPlace = { id: 'work', kind: 'work', name: 'Work', address: '9 Pine St', area: '', lat: 47.62, lng: -122.3 };
const SCHOOL: SavedPlace = { id: 'school', kind: 'school', name: 'School', address: '5 Oak St', area: '', lat: 47.64, lng: -122.3 };

let db: Db;
let client: QueryClient;
/** While set, every read of the trips waits for it (a slow read held open on purpose). */
let hold: Promise<void> | null = null;
let release: () => void = () => undefined;
/** Hold every read of the trips until `release()`. */
const holdReads = () => {
  hold = new Promise<void>((r) => (release = r));
};

const trip = (n: number, startedAt: number, brakes: number, over: Record<string, unknown> = {}) => ({
  client_trip_id: uuid(n),
  started_at: startedAt,
  tz: 'UTC',
  status: 'scored' as const,
  miles: 5,
  duration_s: 20 * 60,
  from_place: 'home',
  to_place: 'work',
  counts_json: JSON.stringify({ hardBrake: brakes }),
  ...over,
});

beforeEach(async () => {
  const real = await createTestDb();
  hold = null;
  db = {
    ...real,
    execute: async (sql, params) => {
      if (hold !== null && sql.includes('FROM trips t')) await hold;
      return real.execute(sql, params);
    },
  };
  client = createQueryClient();
  await seedTrips(db, [
    // This drive, clean, and three earlier ones on the leg with 1, 2 and 2 hard brakes (usual 2).
    trip(1, morning(0), 0),
    trip(2, morning(1), 1),
    trip(3, morning(2), 2),
    trip(4, morning(3), 2),
    // A passenger ride and a drive home: not part of the usual.
    trip(5, morning(4), 0, { status: 'not_driving' }),
    trip(6, morning(5), 0, { from_place: 'work', to_place: 'home' }),
  ]);
});

afterEach(async () => {
  // A failed assertion mid-hold must not leave a read waiting forever.
  release();
  hold = null;
  await waitFor(() => expect(client.isFetching()).toBe(0));
  client.clear();
});

async function driveOf(n: number): Promise<LocalDrive> {
  return (await readScoredDrives(db, null)).find((d) => d.clientTripId === uuid(n))!;
}

/**
 * The hook, plus whether both of its reads had landed for this drive in the same render (`ready`) and
 * whether the drives on hand are another window's held over (`held`). A null line asserted once `ready`
 * is the comparison's own answer, never the loading null.
 */
function useProbe(d: LocalDrive) {
  const line = useCommuteCompare(d);
  const q = useScoredDrives(Math.floor((d.startedAt - 120 * DAY) / HOUR) * HOUR);
  const { places } = usePlaces();
  return { line, ready: q.isSuccess && !q.isPlaceholderData && places !== undefined, held: q.isPlaceholderData };
}

test('no saved places: no line', async () => {
  const d = await driveOf(1);
  const { result } = await renderHook(() => useProbe(d), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.line).toBeNull();
  // The same drive with the places saved has a line: the null above came from the missing places.
  await writePlaces(createSettingsRepo(db), [HOME, WORK]);
  client.clear();
  const again = await renderHook(() => useProbe(d), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(again.result.current.ready).toBe(true));
  expect(again.result.current.line?.kind).toBe('fewer');
});

test("the line from the phone's own drives and places, read in a window rounded down to the hour", async () => {
  await writePlaces(createSettingsRepo(db), [HOME, WORK]);
  const d = await driveOf(1);
  const { result } = await renderHook(() => useCommuteCompare(d), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current).toEqual({ kind: 'fewer', text: 'Fewer events than your usual Home → Work', spoken: 'Fewer events than your usual Home to Work' });
  const since = Math.floor((d.startedAt - 120 * DAY) / HOUR) * HOUR;
  expect(client.getQueryData(queryKeys.scoredDrives(since))).toBeDefined();
});

test('an earlier drive is compared only with the drives before it', async () => {
  await writePlaces(createSettingsRepo(db), [HOME, WORK]);
  // Drive 2 has only drives 3 and 4 before it on the leg: too few.
  const d = await driveOf(2);
  const { result } = await renderHook(() => useProbe(d), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.line).toBeNull();
  // One more earlier drive on the leg makes three: now it has a line (1 hard brake against a usual of 2).
  await seedTrips(db, [trip(7, morning(6), 3)]);
  client.clear();
  const again = await renderHook(() => useProbe(d), { wrapper: wrapperFor(db, client, now) });
  await waitFor(() => expect(again.result.current.ready).toBe(true));
  expect(again.result.current.line?.kind).toBe('fewer');
});

test("moving to another recap, the last window's drives never make a line while this one's read is on its way", async () => {
  await writePlaces(createSettingsRepo(db), [HOME, WORK, SCHOOL]);
  const school = { from_place: 'home', to_place: 'school' };
  const B_AT = Date.UTC(2026, 9, 11, 8, 40); // Oct 11: the earlier recap (its window opens Jun 13)
  const A_AT = Date.UTC(2026, 10, 20, 9, 40); // Nov 20: the later recap (its window opens Jul 23)
  await seedTrips(db, [
    // In B's window only: four clean drives in early July.
    ...[1, 2, 3, 4].map((day) => trip(20 + day, Date.UTC(2026, 6, day, 8, 0), 0, school)),
    // In both windows: three drives with 3 hard brakes each in September.
    ...[1, 2, 3].map((day) => trip(30 + day, Date.UTC(2026, 8, day, 8, 0), 3, school)),
    trip(40, B_AT, 0, school),
    trip(41, A_AT, 0, school),
  ]);
  const a = await driveOf(41);
  const b = await driveOf(40);
  const { result, rerender } = await renderHook(({ d }: { d: LocalDrive }) => useProbe(d), {
    wrapper: wrapperFor(db, client, now),
    initialProps: { d: a },
  });
  // A against B and September (usual 3): fewer.
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.line?.kind).toBe('fewer');

  holdReads();
  await rerender({ d: b });
  // A's window (no July) still on hand: it would say "fewer" for B against September alone.
  await waitFor(() => expect(result.current.held).toBe(true));
  expect(result.current.line).toBeNull();

  release();
  hold = null;
  // B's own window: July and September, usual 0, and B is clean.
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.line).toEqual({ kind: 'clean', text: 'Clean, like your usual Home → School', spoken: 'Clean, like your usual Home to School' });
});
