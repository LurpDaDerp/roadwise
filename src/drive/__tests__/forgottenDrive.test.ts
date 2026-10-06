/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { applyForgotToStartSetting, applyStoredForgotToStartSetting, checkForgottenDrive, FORGOT_TO_START_KEY, FORGOTTEN_CHECKED_AT_KEY, overlapsRecordedDrive } from '@/drive/forgottenDrive';

const T0 = 1_700_000_000_000;
let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

test('the setting is applied natively from storage at boot and on change', async () => {
  const applied: boolean[] = [];
  const deps = { setForgotToStartReminder: async (on: boolean) => void applied.push(on) };
  expect(await applyStoredForgotToStartSetting(db, deps)).toBe(false);
  await createSettingsRepo(db).set(FORGOT_TO_START_KEY, true);
  expect(await applyStoredForgotToStartSetting(db, deps)).toBe(true);
  await applyForgotToStartSetting(false, deps);
  expect(applied).toEqual([false, true, false]);
});

test('a forgotten drive is offered once, only with the setting on, and never when a recorded drive covers it', async () => {
  const settings = createSettingsRepo(db);
  const stretch = { startedAt: T0 - 3_600_000, endedAt: T0 - 3_000_000 };
  const asked: number[] = [];
  const deps = {
    checkForgottenDrive: async (since: number) => {
      asked.push(since);
      return stretch;
    },
  };
  expect(await checkForgottenDrive(db, T0, deps)).toBeNull(); // setting off: nothing asked
  expect(asked).toEqual([]);
  await settings.set(FORGOT_TO_START_KEY, true);
  expect(await checkForgottenDrive(db, T0, deps)).toEqual(stretch);
  expect(asked).toEqual([T0 - 24 * 3_600_000]);
  expect(await settings.get(FORGOTTEN_CHECKED_AT_KEY)).toBe(T0);
  // The next check looks only since the last one.
  await checkForgottenDrive(db, T0 + 1000, deps);
  expect(asked[1]).toBe(T0);
  // A recorded drive over that stretch: no notice.
  await createTripsRepo(db).insert({ client_trip_id: 't', started_at: T0 - 3_300_000, ended_at: T0 - 3_100_000, tz: 'UTC', status: 'scored' }, T0);
  expect(await overlapsRecordedDrive(db, stretch)).toBe(true);
  expect(await checkForgottenDrive(db, T0 + 2000, deps)).toBeNull();
});
