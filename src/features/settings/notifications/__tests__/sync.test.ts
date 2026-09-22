import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { createSettingsRepo } from '@/data/db/settings';
import type { Db } from '@/data/db/driver';
import { syncNotificationPrefs } from '@/features/settings/notifications/sync';
import { LOCAL_SENT_KEY, PREFS_CACHE_KEY } from '@/notifications/keys';
import { recordLocalSent } from '@/notifications/localDelivery';

import { createFakePrefsServer, type FakePrefsServer } from '../__fixtures__/fakePrefsServer';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const UID = '11111111-1111-4111-8111-111111111111';
const LA = 'America/Los_Angeles';
const NOW = Date.parse('2026-09-22T21:00:00Z'); // 14:00 PDT
const DEFAULTS = { quiet_enabled: true, quiet_start: '22:00', quiet_end: '07:00', tz: LA };

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const QUIET_FIELDS = ['quiet_enabled', 'quiet_start', 'quiet_end', 'categories'];

function run(server: FakePrefsServer, over: { zone?: string; now?: number; onError?: jest.Mock } = {}) {
  return syncNotificationPrefs(UID, {
    db,
    client: server.client,
    zone: () => over.zone ?? LA,
    now: () => over.now ?? NOW,
    defaults: async () => DEFAULTS,
    onError: over.onError,
  });
}

describe('syncNotificationPrefs', () => {
  it('no row: inserts only the zone (quiet fields stay null so the defaults keep applying)', async () => {
    const server = createFakePrefsServer();
    expect(await run(server)).toBe('saved');
    expect(server.writes().map((c) => [c.op, c.values])).toEqual([
      ['update', { tz: LA }],
      ['insert', { user_id: UID, tz: LA }],
    ]);
    expect(server.rows[0]).toMatchObject({ quiet_enabled: null, quiet_start: null, quiet_end: null });
  });

  it('sends the zone and the local count together, and nothing else', async () => {
    const settings = createSettingsRepo(db);
    await recordLocalSent(settings, LA, NOW - 60_000);
    const server = createFakePrefsServer([{ user_id: UID, tz: 'UTC' }]);
    expect(await run(server)).toBe('saved');
    const writes = server.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      op: 'update',
      values: { tz: LA, local_sent_day: '2026-09-22', local_sent_count: 1 },
    });
    for (const w of writes) for (const f of QUIET_FIELDS) expect(w.values).not.toHaveProperty(f);
  });

  it('writes nothing when the zone and the count already match', async () => {
    const settings = createSettingsRepo(db);
    await recordLocalSent(settings, LA, NOW - 60_000);
    const server = createFakePrefsServer([
      { user_id: UID, tz: LA, local_sent_day: '2026-09-22', local_sent_count: 1 },
    ]);
    expect(await run(server)).toBe('unchanged');
    expect(server.writes()).toHaveLength(0);
  });

  it('a zero count is not written over another day (the server already reads it as 0)', async () => {
    const server = createFakePrefsServer([
      { user_id: UID, tz: LA, local_sent_day: '2026-09-20', local_sent_count: 2 },
    ]);
    expect(await run(server)).toBe('unchanged');
  });

  it('a changed count for today is sent without the zone when the zone is unchanged', async () => {
    const settings = createSettingsRepo(db);
    await recordLocalSent(settings, LA, NOW - 120_000);
    await recordLocalSent(settings, LA, NOW - 60_000);
    const server = createFakePrefsServer([
      { user_id: UID, tz: LA, local_sent_day: '2026-09-22', local_sent_count: 1 },
    ]);
    expect(await run(server)).toBe('saved');
    expect(server.writes()[0]?.values).toEqual({ local_sent_day: '2026-09-22', local_sent_count: 2 });
  });

  it('the zone is normalised (GMT+5 → Etc/GMT-5)', async () => {
    const server = createFakePrefsServer([{ user_id: UID }]);
    await run(server, { zone: 'GMT+5' });
    expect(server.writes()[0]?.values).toEqual({ tz: 'Etc/GMT-5' });
  });

  it('refreshes the prefs cache with the effective prefs (row ∪ defaults)', async () => {
    const server = createFakePrefsServer([
      { user_id: UID, tz: LA, categories: { recording: false }, quiet_end: '06:00:00' },
    ]);
    await run(server);
    const cached = await createSettingsRepo(db).get<Record<string, unknown>>(PREFS_CACHE_KEY);
    expect(cached).toMatchObject({
      categories: { recording: false, trip_summaries: true },
      quiet: { enabled: true, start: '22:00', end: '06:00' },
    });
  });

  it('rolls the exported local count to the new day', async () => {
    const settings = createSettingsRepo(db);
    await recordLocalSent(settings, LA, NOW - 86_400_000);
    const server = createFakePrefsServer([{ user_id: UID, tz: LA }]);
    await run(server);
    expect(await settings.get(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 0 });
  });

  it('failure is silent: resolves "error" and reports through onError', async () => {
    const server = createFakePrefsServer();
    server.offline = true;
    const onError = jest.fn();
    expect(await run(server, { onError })).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a refused write resolves "error" (and still caches what it read)', async () => {
    const server = createFakePrefsServer([{ user_id: UID, tz: 'UTC', quiet_enabled: false }]);
    server.fail.update = { code: '22023' };
    expect(await run(server)).toBe('error');
    const cached = await createSettingsRepo(db).get<{ quiet: { enabled: boolean } }>(PREFS_CACHE_KEY);
    expect(cached?.quiet.enabled).toBe(false);
  });

  it('never throws, even with no onError', async () => {
    const server = createFakePrefsServer();
    server.offline = true;
    await expect(run(server)).resolves.toBe('error');
  });
});
