/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { budgetFor, freshBudget, NOT_DRIVING_BUDGET_MS, NOT_DRIVING_KEY, parseBudget, readBudget, spend, writeBudget } from '@/drive/notDriving';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

test('the budget is 2 minutes, under the drive.notDriving setting', () => {
  expect(NOT_DRIVING_BUDGET_MS).toBe(120_000);
  expect(NOT_DRIVING_KEY).toBe('drive.notDriving');
});

test('spend adds visible time, caps at 2 min and expires there; an expired budget never changes; nothing for a bad dt', () => {
  let b = freshBudget('a', 0);
  b = spend(b, 60_000, 1);
  expect(b).toEqual({ clientTripId: 'a', spentMs: 60_000, expired: false, updatedAt: 1 });
  b = spend(b, 59_999, 2);
  expect(b.expired).toBe(false);
  b = spend(b, 5_000, 3);
  expect(b).toEqual({ clientTripId: 'a', spentMs: 120_000, expired: true, updatedAt: 3 });
  expect(spend(b, 1000, 4)).toBe(b);
  const f = freshBudget('b', 0);
  expect(spend(f, -5, 1)).toBe(f);
  expect(spend(f, Number.NaN, 1)).toBe(f);
});

test('stored and read back by trip id; another drive’s budget is ignored; anything malformed reads as none', async () => {
  expect(await readBudget(db)).toBeNull();
  await writeBudget(db, { clientTripId: 'a', spentMs: 119_000, expired: false, updatedAt: 9 });
  expect(await budgetFor(db, 'a', 10)).toEqual({ clientTripId: 'a', spentMs: 119_000, expired: false, updatedAt: 9 });
  expect(await budgetFor(db, 'b', 10)).toEqual(freshBudget('b', 10));
  // A relaunch 2 s later spends the last second: expired.
  expect(spend(await budgetFor(db, 'a', 11), 2000, 11).expired).toBe(true);
  for (const bad of [null, 3, {}, { clientTripId: '', spentMs: 0, expired: false, updatedAt: 1 }, { clientTripId: 'a', spentMs: -1, expired: false, updatedAt: 1 }, { clientTripId: 'a', spentMs: 1, expired: 'no', updatedAt: 1 }]) {
    expect(parseBudget(bad)).toBeNull();
  }
  expect(parseBudget({ clientTripId: 'a', spentMs: 500_000, expired: false, updatedAt: 1 })).toEqual({ clientTripId: 'a', spentMs: 120_000, expired: true, updatedAt: 1 });
  await createSettingsRepo(db).set(NOT_DRIVING_KEY, 'x');
  expect(await readBudget(db)).toBeNull();
});
