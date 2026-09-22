/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import type { Profile } from '@/data/supabase/profile';
import {
  PROFILE_CACHE_KEY,
  readProfileCache,
  writeProfileCache,
} from '@/features/auth/profileCache';

const ava = {
  id: 'u1',
  display_name: 'Ava',
  age_band: '18_plus',
  flags: { onboarded: true },
} as unknown as Profile;

let settings: SettingsRepo;

beforeEach(async () => {
  const db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
});

test('the key is profile.cache', () => expect(PROFILE_CACHE_KEY).toBe('profile.cache'));

test('round-trips the row for the same user', async () => {
  await writeProfileCache(settings, ava);
  await expect(readProfileCache(settings, 'u1')).resolves.toEqual(ava);
});

test('nothing cached reads as null', async () => {
  await expect(readProfileCache(settings, 'u1')).resolves.toBeNull();
});

test('is never served to a different user id', async () => {
  await writeProfileCache(settings, ava);
  await expect(readProfileCache(settings, 'u2')).resolves.toBeNull();
});

test('a newer write replaces the older one', async () => {
  await writeProfileCache(settings, ava);
  const ben = { ...ava, id: 'u2', display_name: 'Ben' } as Profile;
  await writeProfileCache(settings, ben);
  await expect(readProfileCache(settings, 'u1')).resolves.toBeNull();
  await expect(readProfileCache(settings, 'u2')).resolves.toEqual(ben);
});

test.each([
  ['a bare string', 'nope'],
  ['no user id', { profile: ava }],
  ['an owner that does not match the row', { userId: 'u1', profile: { ...ava, id: 'u2' } }],
  ['no row', { userId: 'u1' }],
])('a malformed store (%s) reads as null', async (_label, value) => {
  await settings.set(PROFILE_CACHE_KEY, value);
  await expect(readProfileCache(settings, 'u1')).resolves.toBeNull();
});

test('a failing read is null, never a rejection', async () => {
  const broken = { ...settings, get: () => Promise.reject(new Error('disk')) } as SettingsRepo;
  await expect(readProfileCache(broken, 'u1')).resolves.toBeNull();
});
