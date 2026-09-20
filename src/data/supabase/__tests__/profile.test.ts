import {
  fetchProfile,
  recordConsent,
  updateOwnProfile,
  type Consent,
  type ConsentInsert,
  type Profile,
  type ProfilePatch,
} from '@/data/supabase/profile';

type Call = { table: string; method: string; args: unknown[] };

// Read from inside the mocked builder at call time, never at definition time, so the hoisted
// factory below is happy: every builder method records itself here and `single` resolves with
// whatever a test has queued.
const mockCalls: Call[] = [];
const mockResult: { data: unknown; error: unknown } = { data: null, error: null };

jest.mock('@/data/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const builder: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ['select', 'insert', 'update', 'eq']) {
        builder[method] = (...args: unknown[]) => {
          mockCalls.push({ table, method, args });
          return builder;
        };
      }
      builder.single = async () => {
        mockCalls.push({ table, method: 'single', args: [] });
        return mockResult;
      };
      return builder;
    },
  },
}));

const ava: Profile = {
  id: 'u1',
  display_name: 'Ava',
  avatar_path: null,
  age_band: '18_plus',
  driving_stage: 'new',
  units: 'mph',
  locale: 'en-US',
  profile_visibility: 'private',
  level: 3,
  flags: { onboarded: true },
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const payloadOf = (method: string) => mockCalls.find((c) => c.method === method)?.args[0];
const methods = () => mockCalls.map((c) => c.method);

beforeEach(() => {
  mockCalls.length = 0;
  mockResult.data = null;
  mockResult.error = null;
});

test('fetchProfile reads one row by id', async () => {
  mockResult.data = ava;
  await expect(fetchProfile('u1')).resolves.toBe(ava);
  expect(mockCalls[0]?.table).toBe('profiles');
  expect(methods()).toEqual(['select', 'eq', 'single']);
});

test('updateOwnProfile sends only the client-writable columns, even from a spread row', async () => {
  mockResult.data = { ...ava, display_name: 'Ava Prime' };
  // The exact hazard the column grants answer with 42501: a whole row spread into the patch.
  // TypeScript lets a spread through (spread properties are not excess-checked), so the wrapper
  // has to be the thing that strips `id`, `age_band`, `level`, `created_at` and `updated_at`.
  const stale = { ...ava, level: 99, age_band: 'u13' };
  const result = await updateOwnProfile('u1', { ...stale, display_name: 'Ava Prime' });

  expect(mockCalls[0]?.table).toBe('profiles');
  expect(payloadOf('update')).toStrictEqual({
    display_name: 'Ava Prime',
    avatar_path: null,
    driving_stage: 'new',
    units: 'mph',
    locale: 'en-US',
    profile_visibility: 'private',
    flags: { onboarded: true },
  });
  for (const serverOwned of ['id', 'age_band', 'level', 'created_at', 'updated_at']) {
    expect(payloadOf('update')).not.toHaveProperty(serverOwned);
  }
  expect(mockCalls.find((c) => c.method === 'eq')?.args).toEqual(['id', 'u1']);
  expect(methods()).toEqual(['update', 'eq', 'select', 'single']);
  expect(result.display_name).toBe('Ava Prime');
});

test('updateOwnProfile keeps null (clear the column) and drops undefined (leave it alone)', async () => {
  mockResult.data = ava;
  await updateOwnProfile('u1', { avatar_path: null, display_name: undefined });
  expect(payloadOf('update')).toStrictEqual({ avatar_path: null });
});

test('recordConsent sends exactly user_id, type and version', async () => {
  // A full row, server-stamped columns included: only the three client-insertable keys may leave.
  const row: Consent = {
    id: 'c1',
    user_id: 'u1',
    type: 'tos',
    version: '1',
    granted_at: '2026-09-01T00:00:00Z',
    revoked_at: null,
    actor: 'guardian',
  };
  mockResult.data = row;
  const result = await recordConsent('u1', row);

  expect(mockCalls[0]?.table).toBe('consents');
  expect(payloadOf('insert')).toStrictEqual({ user_id: 'u1', type: 'tos', version: '1' });
  expect(methods()).toEqual(['insert', 'select', 'single']);
  expect(result).toBe(row);
});

test('the wrappers surface the server error instead of returning nothing', async () => {
  mockResult.error = { code: '42501', message: 'permission denied' };
  const consent: ConsentInsert = { type: 'tos', version: '1' };
  await expect(updateOwnProfile('u1', { units: 'kmh' })).rejects.toMatchObject({ code: '42501' });
  await expect(recordConsent('u1', consent)).rejects.toMatchObject({ code: '42501' });
});

test('the patch type itself refuses a server-owned column written by hand', () => {
  // @ts-expect-error level is derived on the server; ProfilePatch has no such key
  const patch: ProfilePatch = { level: 2 };
  expect(Object.keys(patch)).toEqual(['level']);
});
