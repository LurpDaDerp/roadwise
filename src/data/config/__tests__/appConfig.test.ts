/** @jest-environment node */
// Type-only: it makes the compiler prove the app client fits the seam, and loads nothing.
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  APP_CONFIG_KEY,
  APP_CONFIG_TABLE,
  readFlag,
  refreshAppConfig,
  type AppConfigSupabase,
} from '@/data/config/appConfig';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import type { Database } from '@/data/supabase/types';

const NOW = 1_790_000_000_000;

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

/** The one read `refreshAppConfig` makes, answered with `reply`, and every call recorded. */
function fakeSupabase(reply: { data: unknown; error: unknown }) {
  const calls: { table: string; columns: string }[] = [];
  const supabase: AppConfigSupabase = {
    from(table) {
      return {
        select(columns) {
          calls.push({ table, columns });
          return Promise.resolve(reply);
        },
      };
    },
  };
  return { supabase, calls };
}

/** What `supabase/seed.sql` holds, as PostgREST returns it. */
const SEEDED = [
  { key: 'feature_flags', value: { camera_beta: true, auto_detect: true, referral: false } },
  { key: 'min_app_version', value: '2.0.0' },
];

test('the app Supabase client satisfies the seam', () => {
  const asSeam = (client: SupabaseClient<Database>): AppConfigSupabase => client;
  expect(typeof asSeam).toBe('function');
});

test('with nothing fetched yet, every flag is its fallback', async () => {
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
  await expect(readFlag(db, 'auto_detect', true)).resolves.toBe(true);
  await expect(readFlag(db, 'camera_beta', false)).resolves.toBe(false);
  await expect(readFlag(db, 'referral', true)).resolves.toBe(true);
});

test('a refresh reads the public config once and the flags follow it', async () => {
  const { supabase, calls } = fakeSupabase({ data: SEEDED, error: null });

  await refreshAppConfig(supabase, db, () => NOW);

  expect(calls).toEqual([{ table: APP_CONFIG_TABLE, columns: 'key,value' }]);
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(true);
  await expect(readFlag(db, 'camera_beta', false)).resolves.toBe(true);
  await expect(readFlag(db, 'referral', true)).resolves.toBe(false);
  expect(await createSettingsRepo(db).get(APP_CONFIG_KEY)).toEqual({
    fetchedAt: NOW,
    flags: { camera_beta: true, auto_detect: true, referral: false },
  });
});

test('a flag the server does not send, or sends as something other than a boolean, falls back', async () => {
  const { supabase } = fakeSupabase({
    data: [{ key: 'feature_flags', value: { auto_detect: 'yes', camera_beta: 1, unknown_flag: true } }],
    error: null,
  });
  await refreshAppConfig(supabase, db, () => NOW);

  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
  await expect(readFlag(db, 'camera_beta', true)).resolves.toBe(true);
  await expect(readFlag(db, 'referral', false)).resolves.toBe(false);
  expect(await createSettingsRepo(db).get(APP_CONFIG_KEY)).toEqual({ fetchedAt: NOW, flags: {} });
});

test('a flag switched off on the server is switched off here at the next refresh', async () => {
  await refreshAppConfig(fakeSupabase({ data: SEEDED, error: null }).supabase, db, () => NOW);
  await refreshAppConfig(
    fakeSupabase({ data: [{ key: 'feature_flags', value: { auto_detect: false } }], error: null })
      .supabase,
    db,
    () => NOW + 1
  );
  await expect(readFlag(db, 'auto_detect', true)).resolves.toBe(false);
  // Gone from the server's row: back to the caller's fallback, not the old value.
  await expect(readFlag(db, 'camera_beta', false)).resolves.toBe(false);
});

test('a failed request rejects and keeps what was stored', async () => {
  await refreshAppConfig(fakeSupabase({ data: SEEDED, error: null }).supabase, db, () => NOW);

  await expect(
    refreshAppConfig(
      fakeSupabase({ data: null, error: { message: 'Failed to fetch' } }).supabase,
      db,
      () => NOW + 1
    )
  ).rejects.toThrow('app config');

  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(true);
});

test('an answer that is not a list of rows rejects and keeps what was stored', async () => {
  await refreshAppConfig(fakeSupabase({ data: SEEDED, error: null }).supabase, db, () => NOW);
  await expect(
    refreshAppConfig(fakeSupabase({ data: { oops: true }, error: null }).supabase, db, () => NOW + 1)
  ).rejects.toThrow('app config');
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(true);
});

test('a stored value this build cannot read falls back rather than throwing', async () => {
  await db.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
    APP_CONFIG_KEY,
    '{not json',
  ]);
  await expect(readFlag(db, 'auto_detect', true)).resolves.toBe(true);
  await createSettingsRepo(db).set(APP_CONFIG_KEY, { flags: 'nope' });
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
});
