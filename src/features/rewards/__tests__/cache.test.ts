import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import { readCachedRewards, REWARDS_CACHE_KEY, writeCachedRewards } from '../cache';
import { OTHER_UID, snapshot, UID } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

test('the key is rewards.snapshot, holding { uid, snapshot }', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const s = snapshot();
  await writeCachedRewards(settings, UID, s);
  expect(REWARDS_CACHE_KEY).toBe('rewards.snapshot');
  expect(await settings.get(REWARDS_CACHE_KEY)).toEqual({ uid: UID, snapshot: s });
});

test('read back for the same uid; null for another uid', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const s = snapshot();
  await writeCachedRewards(settings, UID, s);
  await expect(readCachedRewards(settings, UID)).resolves.toEqual(s);
  await expect(readCachedRewards(settings, OTHER_UID)).resolves.toBeNull();
});

test('nothing cached, or a shape this build cannot read: null', async () => {
  const settings = createSettingsRepo(await createTestDb());
  await expect(readCachedRewards(settings, UID)).resolves.toBeNull();
  await settings.set(REWARDS_CACHE_KEY, { uid: UID, snapshot: { ...snapshot(), progress: { points: 'lots' } } });
  await expect(readCachedRewards(settings, UID)).resolves.toBeNull();
  await settings.set(REWARDS_CACHE_KEY, 'garbage');
  await expect(readCachedRewards(settings, UID)).resolves.toBeNull();
});
