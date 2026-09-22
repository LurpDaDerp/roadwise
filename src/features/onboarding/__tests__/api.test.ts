import { DEVICE_TABLES } from '@/boot/device';
import { legalState } from '@/features/auth/legal';
import { readProfileCache } from '@/features/auth/profileCache';
import { createQueueRepo, createSamplesRepo, createSettingsRepo, type Db } from '@/data/db';
import { onDataChanged } from '@/data/events';
import { createTestDb, seedDay, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';

import {
  acknowledgeDisclaimer,
  BLOCK_PURGED_KEY,
  CHILD_DRIVE_TABLES,
  KEPT_SETTINGS,
  markBlockPurged,
  readBlockPurged,
  PURGE_MAX_ROUNDS,
  fetchOwnConsents,
  purgeLocalDriveData,
  purgeOwnObjects,
  readAgeBand,
  readPrivateProfile,
  recordCurrentTerms,
  saveProfileBasics,
  setBirthDate,
} from '../api';

// ---------------------------------------------------------------------------------------------
// The app client, as far as these calls reach into it.
// ---------------------------------------------------------------------------------------------

type Reply = { data: unknown; error: unknown };

const mockRpc = jest.fn(async (_fn: string, _args: unknown): Promise<Reply> => ({ data: null, error: null }));
/** Each `from(table)` chain resolves to the next reply queued for that table. */
const mockTables: Record<string, Reply[]> = {};
const mockCalls: { table: string; ops: [string, unknown[]][] }[] = [];
const mockList = jest.fn(async (_prefix: string, _opts: unknown): Promise<Reply> => ({ data: [], error: null }));
const mockRemove = jest.fn(async (_paths: string[]): Promise<Reply> => ({ data: [], error: null }));
const mockBuckets: string[] = [];

jest.mock('@/data/supabase/client', () => {
  function chain(table: string) {
    const call = { table, ops: [] as [string, unknown[]][] };
    mockCalls.push(call);
    const reply = () => Promise.resolve(mockTables[table]?.shift() ?? { data: null, error: null });
    const proxy: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'in', 'update']) {
      proxy[op] = (...args: unknown[]) => {
        call.ops.push([op, args]);
        return proxy;
      };
    }
    proxy.single = () => {
      call.ops.push(['single', []]);
      return reply();
    };
    proxy.then = (resolve: (r: Reply) => unknown, reject: (e: unknown) => unknown) =>
      reply().then(resolve, reject);
    return proxy;
  }
  return {
    supabase: {
      rpc: (fn: string, args: unknown) => mockRpc(fn, args),
      from: (table: string) => chain(table),
      storage: {
        from: (bucket: string) => {
          mockBuckets.push(bucket);
          return {
            list: (prefix: string, opts: unknown) => mockList(prefix, opts),
            remove: (paths: string[]) => mockRemove(paths),
          };
        },
      },
    },
  };
});

const mockUpdateOwnProfile = jest.fn(async (_id: string, patch: unknown) => ({ id: 'u', ...(patch as object) }));
const mockRecordConsent = jest.fn(async (_id: string, _c: unknown) => ({}));
jest.mock('@/data/supabase/profile', () => ({
  updateOwnProfile: (id: string, patch: unknown) => mockUpdateOwnProfile(id, patch),
  recordConsent: (id: string, c: unknown) => mockRecordConsent(id, c),
}));

const mockCancelDriveSummaries = jest.fn(async () => {});
jest.mock('@/features/drive/summaryNotifier', () => ({
  cancelDriveSummaries: () => mockCancelDriveSummaries(),
}));

beforeEach(() => {
  mockRpc.mockClear();
  mockList.mockReset();
  mockRemove.mockReset();
  mockUpdateOwnProfile.mockClear();
  mockRecordConsent.mockReset().mockResolvedValue({});
  mockCancelDriveSummaries.mockClear();
  mockCalls.length = 0;
  mockBuckets.length = 0;
  for (const key of Object.keys(mockTables)) delete mockTables[key];
});

describe('setBirthDate', () => {
  it('sends the date to set_birth_date and reports it set', async () => {
    await expect(setBirthDate('2008-03-04')).resolves.toBe('set');
    expect(mockRpc).toHaveBeenCalledWith('set_birth_date', { p_birth_date: '2008-03-04' });
  });

  it("reports 0001's refusal of a second write as already-set", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'birth date already set' },
    });
    await expect(setBirthDate('2008-03-04')).resolves.toBe('already-set');
  });

  it.each([
    { code: '23514', message: 'birth_date must be a date between 120 years ago and today' },
    { code: '42501', message: 'set_birth_date requires an authenticated user' },
    { code: 'PGRST', message: 'Network request failed' },
  ])('rejects on any other failure (%p)', async (error) => {
    mockRpc.mockResolvedValueOnce({ data: null, error });
    await expect(setBirthDate('2008-03-04')).rejects.toBe(error);
  });
});

describe('acknowledgeDisclaimer', () => {
  it("merges only disclaimerAcknowledged through T2's merge_own_profile_flags", async () => {
    await acknowledgeDisclaimer('2026-09-21');
    expect(mockRpc).toHaveBeenCalledWith('merge_own_profile_flags', {
      patch: { disclaimerAcknowledged: '2026-09-21' },
    });
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
  });

  it('rejects when the merge fails', async () => {
    const error = { code: '22023', message: 'bad patch' };
    mockRpc.mockResolvedValueOnce({ data: null, error });
    await expect(acknowledgeDisclaimer('2026-09-21')).rejects.toBe(error);
  });
});

describe('reads', () => {
  it("readPrivateProfile reads the caller's own birth date", async () => {
    mockTables.private_profiles = [{ data: { birth_date: '2001-02-03' }, error: null }];
    await expect(readPrivateProfile('u1')).resolves.toEqual({ birthDate: '2001-02-03' });
    expect(mockCalls[0]?.ops).toEqual([
      ['select', ['birth_date']],
      ['eq', ['user_id', 'u1']],
      ['single', []],
    ]);
  });

  it('readPrivateProfile: no answer yet is null, a failed read rejects', async () => {
    mockTables.private_profiles = [
      { data: { birth_date: null }, error: null },
      { data: null, error: new Error('offline') },
    ];
    await expect(readPrivateProfile('u1')).resolves.toEqual({ birthDate: null });
    await expect(readPrivateProfile('u1')).rejects.toThrow('offline');
  });

  it.each([
    ['u13', 'u13'],
    ['13_17', '13_17'],
    ['18_plus', '18_plus'],
    ['unknown', 'unknown'],
    [null, 'unknown'],
    ['something-new', 'unknown'],
  ])('readAgeBand %p → %p', async (stored, band) => {
    mockTables.profiles = [{ data: { age_band: stored }, error: null }];
    await expect(readAgeBand('u1')).resolves.toBe(band);
  });

  it("fetchOwnConsents asks for the account's Terms and Privacy rows only", async () => {
    mockTables.consents = [{ data: [{ type: 'tos', version: 't1', revoked_at: null }], error: null }];
    await expect(fetchOwnConsents('u1')).resolves.toEqual([
      { type: 'tos', version: 't1', revoked_at: null },
    ]);
    expect(mockCalls[0]?.ops).toEqual([
      ['select', ['type,version,revoked_at']],
      ['eq', ['user_id', 'u1']],
      ['in', ['type', ['tos', 'privacy']]],
    ]);
  });
});

describe('saveProfileBasics', () => {
  it('writes only the name and the stage, through the M0 profile write', async () => {
    await saveProfileBasics('u1', { displayName: 'Sam', drivingStage: 'permit' });
    expect(mockUpdateOwnProfile).toHaveBeenCalledWith('u1', {
      display_name: 'Sam',
      driving_stage: 'permit',
    });
  });
});

describe('recordCurrentTerms', () => {
  const published = legalState({
    onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
    legal_urls: { terms: 'https://x.example/t', privacy: 'https://x.example/p' },
  });
  const unpublished = legalState({
    onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
    legal_urls: { terms: 'https://x.example/t' },
  });

  it('unpublished: records nothing and asks the server nothing', async () => {
    await expect(recordCurrentTerms('u1', unpublished)).resolves.toEqual([]);
    expect(mockCalls).toEqual([]);
    expect(mockRecordConsent).not.toHaveBeenCalled();
  });

  it('published: records both at the published versions', async () => {
    mockTables.consents = [{ data: [], error: null }];
    await expect(recordCurrentTerms('u1', published)).resolves.toEqual(['tos', 'privacy']);
    expect(mockRecordConsent.mock.calls).toEqual([
      ['u1', { type: 'tos', version: 't-2' }],
      ['u1', { type: 'privacy', version: 'p-3' }],
    ]);
  });

  it('skips a live consent at the current version; an older or revoked one does not count', async () => {
    mockTables.consents = [
      {
        data: [
          { type: 'tos', version: 't-2', revoked_at: null },
          { type: 'privacy', version: 'p-2', revoked_at: null },
          { type: 'privacy', version: 'p-3', revoked_at: '2026-01-01T00:00:00Z' },
        ],
        error: null,
      },
    ];
    await expect(recordCurrentTerms('u1', published)).resolves.toEqual(['privacy']);
    expect(mockRecordConsent.mock.calls).toEqual([['u1', { type: 'privacy', version: 'p-3' }]]);
  });

  it('a failed read records nothing and rejects', async () => {
    mockTables.consents = [{ data: null, error: new Error('offline') }];
    await expect(recordCurrentTerms('u1', published)).rejects.toThrow('offline');
    expect(mockRecordConsent).not.toHaveBeenCalled();
  });
});

describe('purgeOwnObjects', () => {
  const file = (name: string) => ({ name, id: `id-${name}` });

  it('removes every object under the account prefix in traces, page by page, then says done', async () => {
    mockList
      .mockResolvedValueOnce({ data: [file('a.bin.gz'), file('b.bin.gz')], error: null })
      .mockResolvedValueOnce({ data: [file('c.bin.gz')], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    mockRemove.mockImplementation(async (paths) => ({ data: paths.map((p) => ({ name: p })), error: null }));

    await expect(purgeOwnObjects('u1')).resolves.toBe('done');
    expect(mockBuckets).toEqual(['traces']);
    expect(mockList).toHaveBeenCalledWith('u1', { limit: 100, offset: 0 });
    expect(mockRemove.mock.calls).toEqual([
      [['u1/a.bin.gz', 'u1/b.bin.gz']],
      [['u1/c.bin.gz']],
    ]);
  });

  it('an account with nothing stored is done at once', async () => {
    mockList.mockResolvedValueOnce({ data: [], error: null });
    await expect(purgeOwnObjects('u1')).resolves.toBe('done');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed list', () => mockList.mockResolvedValueOnce({ data: null, error: new Error('offline') })],
    ['a list that throws', () => mockList.mockRejectedValueOnce(new Error('offline'))],
    [
      'a failed remove',
      () => {
        mockList.mockResolvedValueOnce({ data: [file('a.bin.gz')], error: null });
        mockRemove.mockResolvedValueOnce({ data: null, error: new Error('500') });
      },
    ],
    [
      'a remove that removed nothing (a refusing policy)',
      () => {
        mockList.mockResolvedValueOnce({ data: [file('a.bin.gz')], error: null });
        mockRemove.mockResolvedValueOnce({ data: [], error: null });
      },
    ],
    [
      'a nested folder it does not walk',
      () => mockList.mockResolvedValueOnce({ data: [{ name: 'avatars', id: null }], error: null }),
    ],
  ])('%s is partial, never done', async (_what, arrange) => {
    arrange();
    await expect(purgeOwnObjects('u1')).resolves.toBe('partial');
  });

  it('a listing that never empties stops after the round limit, partial', async () => {
    mockList.mockResolvedValue({ data: [file('stuck.bin.gz')], error: null });
    mockRemove.mockResolvedValue({ data: [{ name: 'stuck' }], error: null });
    await expect(purgeOwnObjects('u1')).resolves.toBe('partial');
    expect(mockList).toHaveBeenCalledTimes(PURGE_MAX_ROUNDS);
  });
});

describe('purgeLocalDriveData', () => {
  const TRIP = 'child-trip';
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  async function countOf(table: string): Promise<number> {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number((rows[0] as Record<string, unknown>).n);
  }

  async function seedChildDrives(): Promise<void> {
    await seedTrips(db, [tripRow({ client_trip_id: TRIP })]);
    await seedEvents(db, [eventRow({ id: 'e1', client_trip_id: TRIP })]);
    await createSamplesRepo(db).append(TRIP, T0, { speed: 10 });
    const queue = createQueueRepo(db);
    await queue.enqueue('finalize-trip', { clientTripId: TRIP }, `key:${TRIP}`, T0);
    await queue.enqueue('dispute', { clientTripId: TRIP }, `dispute:${TRIP}`, T0);
    // The upload the server answered `age_pending`: waiting, attempts untouched (T1 r3).
    await db.execute('UPDATE sync_queue SET next_attempt_at = ? WHERE idempotency_key = ?', [
      T0 + 900_000,
      `key:${TRIP}`,
    ]);
    await seedDay(db, '2026-01-05', { day: '2026-01-05', safeDay: true }, T0);
    await db.execute(
      'INSERT OR REPLACE INTO speed_limit_tiles (tile_key, expires_at, segments_json) VALUES (?, ?, ?)',
      ['tile-1', T0 + 86_400_000, '[]']
    );
    await createSettingsRepo(db).set('device.lastUserId', 'child');
    await createSettingsRepo(db).set('config.app', { fetchedAt: T0, flags: {} });
  }

  it('takes every drive, sample and queued item — the age_pending upload included — and the traces', async () => {
    await seedChildDrives();
    expect(await countOf('sync_queue')).toBe(2);
    const cleared = jest.fn(async () => {});

    await purgeLocalDriveData(db, { traces: { clear: cleared } });

    for (const table of CHILD_DRIVE_TABLES) expect({ table, n: await countOf(table) }).toEqual({ table, n: 0 });
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(mockCancelDriveSummaries).toHaveBeenCalledTimes(1);
  });

  it('keeps only the allowlisted settings the signed-in app still runs on', async () => {
    await seedChildDrives();
    const settings = createSettingsRepo(db);
    await settings.set('session.uid', 'child');
    await settings.set('auth.disclaimerAcknowledged', '2026-09-21');
    await settings.set('onboarding.step', 'not-eligible');
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    expect(await settings.get('device.lastUserId')).toBe('child');
    expect(await settings.get('session.uid')).toBe('child');
    expect(await settings.get('config.app')).toEqual({ fetchedAt: T0, flags: {} });
    expect(await settings.get('auth.disclaimerAcknowledged')).toBe('2026-09-21');
    expect(await settings.get('onboarding.step')).toBe('not-eligible');
  });

  it.each([
    // Drive-derived: habitual route cells, per-drive answers and arbiter state, opened trip ids.
    ['role.routes', [{ key: 'dr5ru>dr5rv', driver: 3, other: 0 }]],
    ['role.answer.child-trip', 'dr5ru>dr5rv'],
    ['role.prior', { driver: 0.8 }],
    ['engine.arbiter.child-trip', { state: 1 }],
    ['notifications.openedTrips', ['child-trip']],
    ['insights.baseline', { brake: 1 }],
    ['hydrate.cursor', 'x'],
    ['trips.deletedIds', ['t']],
    ['onboarding.consents', { userId: 'child', rows: [] }],
    ['permissions.pendingDisclosureConsent', { uid: 'child' }],
    ['onboarding.pendingHref', '/trips/child-trip/summary'],
    // The auto-record opt-in and its intent: a child released at 13 opts in again, disclosure first.
    ['drive.autoDetect', true],
    ['permissions.autoRecordIntent', true],
    // A key no task has written yet: removed by default, because the list is an allowlist.
    ['some.future.drive.key', { whatever: true }],
  ])('removes %s', async (key, value) => {
    const settings = createSettingsRepo(db);
    await settings.set(key, value);
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    expect(await settings.get(key)).toBeNull();
  });

  it('reduces the profile cache to the owner and the u13 band, so a relaunch never arms (H2)', async () => {
    await seedChildDrives();
    const settings = createSettingsRepo(db);
    await settings.set('profile.cache', {
      userId: 'child',
      profile: { id: 'child', age_band: 'u13', display_name: 'Kid', driving_stage: 'permit', flags: { a: 1 } },
    });
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    const cached = await readProfileCache(settings, 'child');
    expect(cached?.age_band).toBe('u13');
    expect(cached).toEqual({ id: 'child', age_band: 'u13' });
    expect(await settings.get('profile.cache')).toEqual({
      userId: 'child',
      profile: { id: 'child', age_band: 'u13' },
    });
  });

  it('writes that minimal cache even when none was stored, and none without an owner', async () => {
    const settings = createSettingsRepo(db);
    await settings.set('device.lastUserId', 'child');
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    expect(await readProfileCache(settings, 'child')).toEqual({ id: 'child', age_band: 'u13' });
    await settings.remove('device.lastUserId');
    await settings.set('profile.cache', { userId: 'x', profile: { id: 'x', display_name: 'X' } });
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    expect(await settings.get('profile.cache')).toBeNull();
  });

  it('the allowlist holds no drive-derived key', () => {
    for (const key of KEPT_SETTINGS) {
      expect(key).not.toMatch(/^(role|engine|trips|hydrate|insights|notifications)\./);
    }
  });

  it('the purged stamp is per account', async () => {
    expect(await readBlockPurged(db, 'child')).toBe(false);
    await markBlockPurged(db, 'child', () => T0);
    expect(await readBlockPurged(db, 'child')).toBe(true);
    expect(await readBlockPurged(db, 'someone-else')).toBe(false);
    expect(await createSettingsRepo(db).get(BLOCK_PURGED_KEY)).toEqual({ userId: 'child', at: T0 });
    // It survives a later purge: it is on the allowlist.
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    expect(await readBlockPurged(db, 'child')).toBe(true);
  });

  it('covers every table the handover wipe covers except settings', () => {
    expect([...CHILD_DRIVE_TABLES].sort()).toEqual(
      DEVICE_TABLES.filter((t) => t !== 'settings').sort()
    );
  });

  it('rejects when the traces cannot be cleared, so nobody is told the phone is clean', async () => {
    await seedChildDrives();
    await expect(
      purgeLocalDriveData(db, {
        traces: {
          clear: async () => {
            throw new Error('EACCES');
          },
        },
      })
    ).rejects.toThrow('EACCES');
  });

  it('a summary that will not cancel does not stop the purge', async () => {
    await seedChildDrives();
    await purgeLocalDriveData(db, {
      traces: { clear: async () => {} },
      cancelSummaries: async () => {
        throw new Error('no module');
      },
    });
    expect(await countOf('trips')).toBe(0);
  });

  it('tells mounted screens the rows moved', async () => {
    const heard = jest.fn();
    const off = onDataChanged(heard);
    await purgeLocalDriveData(db, { traces: { clear: async () => {} } });
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(heard).toHaveBeenCalledWith({ source: 'hydrate' });
  });
});
