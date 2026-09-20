/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';

const T0 = 1_700_000_000_000;

interface Day {
  safeDay: boolean;
  points: number;
}

let db: Db;
let cache: ReturnType<typeof createScoreDailyCacheRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  cache = createScoreDailyCacheRepo(db);
});

test('a cached day round-trips with the time it was written', async () => {
  await cache.put('2026-09-20', { safeDay: true, points: 50 }, T0);

  await expect(cache.get<Day>('2026-09-20')).resolves.toEqual({
    day: '2026-09-20',
    payload: { safeDay: true, points: 50 },
    updated_at: T0,
  });
  await expect(cache.get('2026-09-19')).resolves.toBeNull();
});

test('writing a day again replaces it — the server recomputes the whole day', async () => {
  await cache.put('2026-09-20', { safeDay: false, points: 0 }, T0);
  await cache.put('2026-09-20', { safeDay: true, points: 50 }, T0 + 60_000);

  await expect(cache.get<Day>('2026-09-20')).resolves.toEqual({
    day: '2026-09-20',
    payload: { safeDay: true, points: 50 },
    updated_at: T0 + 60_000,
  });
});

test('range reads a week oldest first, both ends inclusive', async () => {
  for (const day of ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21']) {
    await cache.put(day, { day }, T0);
  }

  const week = await cache.range('2026-09-19', '2026-09-21');
  expect(week.map((entry) => entry.day)).toEqual(['2026-09-19', '2026-09-20', '2026-09-21']);
});

test('a day written on a transaction handle is undone with it', async () => {
  await expect(
    db.transaction(async (tx) => {
      await cache.put('2026-09-20', { points: 50 }, T0, tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');

  await expect(cache.get('2026-09-20')).resolves.toBeNull();
});

test('remove and purgeBefore clear what the screens no longer read', async () => {
  for (const day of ['2026-09-18', '2026-09-19', '2026-09-20']) await cache.put(day, {}, T0);

  await expect(cache.remove('2026-09-20')).resolves.toBe(true);
  await expect(cache.remove('2026-09-20')).resolves.toBe(false);
  await expect(cache.purgeBefore('2026-09-19')).resolves.toBe(1);
  expect((await cache.range('2000-01-01', '2100-01-01')).map((e) => e.day)).toEqual([
    '2026-09-19',
  ]);
});
