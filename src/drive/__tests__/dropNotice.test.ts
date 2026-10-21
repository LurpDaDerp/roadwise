/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { clearDropNotice, DROP_NOTICE_KEY, isManualDrop, parseDropNotice, readDropNotice, writeDropNotice } from '@/drive/dropNotice';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

test('the newest drop overwrites the last; clear removes it', async () => {
  expect(await readDropNotice(db)).toBeNull();
  await writeDropNotice(db, { clientTripId: 'a', cause: 'stopped', reason: 'no_movement', at: 1 });
  expect(parseDropNotice({ clientTripId: 'b', cause: 'walking', reason: 'not_driven', at: 2 })).toEqual({ clientTripId: 'b', cause: 'walking', reason: 'not_driven', at: 2 });
  expect(parseDropNotice({ clientTripId: 'b', cause: 'walking', reason: 'never_driven', at: 2 })).toBeNull();
  await writeDropNotice(db, { clientTripId: 'b', cause: 'orphan', reason: 'no_gps', at: 2 });
  expect(await readDropNotice(db)).toEqual({ clientTripId: 'b', cause: 'orphan', reason: 'no_gps', at: 2 });
  await clearDropNotice(db);
  expect(await readDropNotice(db)).toBeNull();
});

test('anything that is not a notice reads as none', async () => {
  for (const bad of [null, 'x', 3, {}, { clientTripId: 'a', cause: 'parked', reason: 'no_gps', at: 1 }, { clientTripId: 'a', cause: 'manual', reason: 'tired', at: 1 }, { clientTripId: 'a', cause: 'manual', reason: 'no_gps', at: Number.NaN }]) {
    expect(parseDropNotice(bad)).toBeNull();
  }
  await createSettingsRepo(db).set(DROP_NOTICE_KEY, { clientTripId: 7 });
  expect(await readDropNotice(db)).toBeNull();
  for (const cause of ['manual', 'stopped', 'walking', 'orphan', 'limit'] as const) {
    expect(parseDropNotice({ clientTripId: 'a', cause, reason: 'no_movement', at: 1 })).toMatchObject({ cause });
  }
});

test('the notice keeps how the drive began: an automatic drive’s drop is never one for Home; an older notice with none reads as a Start', async () => {
  await writeDropNotice(db, { clientTripId: 'a', cause: 'stopped', reason: 'not_driven', at: 1, origin: 'auto' });
  const auto = (await readDropNotice(db))!;
  expect(auto).toEqual({ clientTripId: 'a', cause: 'stopped', reason: 'not_driven', at: 1, origin: 'auto' });
  expect(isManualDrop(auto)).toBe(false);
  await writeDropNotice(db, { clientTripId: 'b', cause: 'manual', reason: 'no_movement', at: 2, origin: 'manual' });
  expect(isManualDrop((await readDropNotice(db))!)).toBe(true);
  const old = parseDropNotice({ clientTripId: 'c', cause: 'stopped', reason: 'no_movement', at: 3, origin: 'robot' })!;
  expect(old).toEqual({ clientTripId: 'c', cause: 'stopped', reason: 'no_movement', at: 3 });
  expect(isManualDrop(old)).toBe(true);
});

test('a "Not driving?" cancel reason parses (it is never written: Home says nothing for it)', () => {
  expect(parseDropNotice({ clientTripId: 'a', cause: 'manual', reason: 'cancelled', at: 1 })).toMatchObject({ reason: 'cancelled' });
});
