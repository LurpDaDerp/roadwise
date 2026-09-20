/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createTilesRepo } from '@/data/db/tiles';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

interface Segment {
  key: string;
  limitMph: number;
}

const segments: Segment[] = [
  { key: 'w1', limitMph: 35 },
  { key: 'w2', limitMph: 45 },
];

let db: Db;
let tiles: ReturnType<typeof createTilesRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  tiles = createTilesRepo(db);
});

test('a stored tile reads back with its segments parsed', async () => {
  await tiles.putTile('14/2621/5723', T0 + HOUR, segments);

  const tile = await tiles.getTile<Segment[]>('14/2621/5723', T0);
  expect(tile).toEqual({ tile_key: '14/2621/5723', expires_at: T0 + HOUR, segments });
});

test('getTile returns null for a tile that was never fetched', async () => {
  await expect(tiles.getTile('14/0/0', T0)).resolves.toBeNull();
});

test('a tile is stale from the instant it expires', async () => {
  await tiles.putTile('t', T0 + HOUR, segments);

  await expect(tiles.getTile<Segment[]>('t', T0 + HOUR - 1)).resolves.not.toBeNull();
  await expect(tiles.getTile<Segment[]>('t', T0 + HOUR)).resolves.toBeNull();
  await expect(tiles.getTile<Segment[]>('t', T0 + HOUR + 1)).resolves.toBeNull();
});

test('putTile replaces a tile already held under the key', async () => {
  await tiles.putTile('t', T0 + HOUR, segments);
  await tiles.putTile('t', T0 + 2 * HOUR, [{ key: 'w3', limitMph: 25 }]);

  const tile = await tiles.getTile<Segment[]>('t', T0);
  expect(tile).toEqual({
    tile_key: 't',
    expires_at: T0 + 2 * HOUR,
    segments: [{ key: 'w3', limitMph: 25 }],
  });
});

test('purgeExpired drops only the stale tiles and reports the count', async () => {
  await tiles.putTile('stale-1', T0, segments);
  await tiles.putTile('stale-2', T0 - HOUR, segments);
  await tiles.putTile('fresh', T0 + HOUR, segments);

  await expect(tiles.purgeExpired(T0)).resolves.toBe(2);
  await expect(tiles.getTile('stale-1', T0 - 2 * HOUR)).resolves.toBeNull();
  await expect(tiles.getTile<Segment[]>('fresh', T0)).resolves.not.toBeNull();
});

test('count reports how many tiles are cached', async () => {
  await expect(tiles.count()).resolves.toBe(0);
  await tiles.putTile('a', T0 + HOUR, segments);
  await tiles.putTile('b', T0 + HOUR, segments);
  await expect(tiles.count()).resolves.toBe(2);
});
