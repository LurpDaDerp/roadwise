/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { clearDropNotice, DROP_NOTICE_KEY, parseDropNotice, readDropNotice, writeDropNotice } from '@/drive/dropNotice';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

test('the newest drop overwrites the last; clear removes it', async () => {
  expect(await readDropNotice(db)).toBeNull();
  await writeDropNotice(db, { clientTripId: 'a', cause: 'stopped', reason: 'no_movement', at: 1 });
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
