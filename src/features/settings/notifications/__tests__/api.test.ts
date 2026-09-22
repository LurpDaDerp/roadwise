import {
  PREFS_COLUMNS,
  PrefsOfflineError,
  PrefsSchema,
  readPrefs,
  savePrefs,
} from '@/features/settings/notifications/api';

import { createFakePrefsServer } from '../__fixtures__/fakePrefsServer';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const UID = '11111111-1111-4111-8111-111111111111';

describe('PrefsSchema', () => {
  it('reads a row as the server sends it', () => {
    const row = PrefsSchema.parse({
      user_id: UID,
      categories: { trip_summaries: false },
      quiet_enabled: null,
      quiet_start: '22:00:00',
      quiet_end: null,
      tz: 'America/Los_Angeles',
      local_sent_day: '2026-09-22',
      local_sent_count: 1,
    });
    expect(row.categories).toEqual({ trip_summaries: false });
  });

  it('drops an unknown category key rather than refusing the row', () => {
    const row = PrefsSchema.parse({
      user_id: UID,
      categories: { trip_summaries: true, future_thing: false },
      quiet_enabled: null,
      quiet_start: null,
      quiet_end: null,
      tz: null,
      local_sent_day: null,
      local_sent_count: 0,
    });
    expect(row.categories).toEqual({ trip_summaries: true });
  });

  it('lists exactly the granted columns, never *', () => {
    expect(PREFS_COLUMNS.split(',').sort()).toEqual(
      [
        'categories',
        'local_sent_count',
        'local_sent_day',
        'quiet_enabled',
        'quiet_end',
        'quiet_start',
        'tz',
        'user_id',
      ].sort()
    );
  });
});

describe('readPrefs', () => {
  it('returns null when the account has no row', async () => {
    const server = createFakePrefsServer();
    expect(await readPrefs(UID, server.client)).toBeNull();
    expect(server.calls[0]).toMatchObject({ op: 'select', filters: [['user_id', UID]], columns: PREFS_COLUMNS });
  });

  it('returns the row', async () => {
    const server = createFakePrefsServer([{ user_id: UID, quiet_enabled: false }]);
    expect(await readPrefs(UID, server.client)).toMatchObject({ user_id: UID, quiet_enabled: false });
  });

  it('a transport failure is PrefsOfflineError; a refusal is rethrown', async () => {
    const server = createFakePrefsServer();
    server.offline = true;
    await expect(readPrefs(UID, server.client)).rejects.toBeInstanceOf(PrefsOfflineError);
    server.offline = false;
    server.fail.select = { code: '42501' };
    await expect(readPrefs(UID, server.client)).rejects.toEqual({ code: '42501' });
  });
});

describe('savePrefs', () => {
  it('inserts with user_id when there is no row, sending only the patch', async () => {
    const server = createFakePrefsServer();
    const row = await savePrefs(UID, { quiet_enabled: false }, server.client);
    expect(row.quiet_enabled).toBe(false);
    expect(server.writes().map((c) => [c.op, c.values])).toEqual([
      ['update', { quiet_enabled: false }],
      ['insert', { user_id: UID, quiet_enabled: false }],
    ]);
  });

  it('updates without user_id when the row exists (no UPDATE grant on user_id)', async () => {
    const server = createFakePrefsServer([{ user_id: UID }]);
    await savePrefs(UID, { quiet_start: '23:00' }, server.client);
    expect(server.writes().map((c) => [c.op, c.values])).toEqual([['update', { quiet_start: '23:00' }]]);
    expect(server.rows[0]?.quiet_start).toBe('23:00');
  });

  it('never sends a column outside the grants, even if a caller passes one', async () => {
    const server = createFakePrefsServer([{ user_id: UID }]);
    const patch = { tz: 'UTC', user_id: 'someone-else', created_at: 'x' } as unknown as Parameters<
      typeof savePrefs
    >[1];
    await savePrefs(UID, patch, server.client);
    expect(server.writes()[0]?.values).toEqual({ tz: 'UTC' });
  });

  it('a row created between the update and the insert (23505) is written by one more update', async () => {
    const server = createFakePrefsServer();
    server.beforeInsert = () => server.rows.push({ user_id: UID });
    const row = await savePrefs(UID, { tz: 'UTC' }, server.client);
    expect(row.tz).toBe('UTC');
    expect(server.writes().map((c) => c.op)).toEqual(['update', 'insert', 'update']);
  });

  it('never upserts', async () => {
    const server = createFakePrefsServer();
    await savePrefs(UID, { tz: 'UTC' }, server.client);
    await savePrefs(UID, { tz: 'Europe/Paris' }, server.client);
    expect(server.calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('an empty patch writes nothing and returns the row', async () => {
    const server = createFakePrefsServer([{ user_id: UID, tz: 'UTC' }]);
    const row = await savePrefs(UID, {}, server.client);
    expect(row.tz).toBe('UTC');
    expect(server.writes()).toHaveLength(0);
  });

  it('a failed write rejects', async () => {
    const server = createFakePrefsServer([{ user_id: UID }]);
    server.fail.update = { code: '22023', message: 'unknown time zone' };
    await expect(savePrefs(UID, { tz: 'Nope/Nope' }, server.client)).rejects.toMatchObject({ code: '22023' });
  });
});
