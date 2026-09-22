/**
 * Final review m4: every reader outside the query hooks shares the health query's phone read, so a
 * foreground reads the permissions once, whoever asks.
 */
import { QueryClient } from '@tanstack/react-query';

import { createSettingsRepo } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { fakeAdapter, snap } from '@/features/permissions/__fixtures__/harness';
import { SHARED_READ_MS, sharedPermissionSnapshot } from '@/features/permissions/usePermissionHealth';

jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));
jest.mock('@/data/supabase/session', () => ({ useSession: jest.fn() }));

test('concurrent readers share one read of the phone', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const adapter = fakeAdapter(snap());
  const client = new QueryClient();
  const [a, b] = await Promise.all([
    sharedPermissionSnapshot(client, 'u1', adapter, settings),
    sharedPermissionSnapshot(client, 'u1', adapter, settings),
  ]);
  expect(a).toEqual(b);
  expect(adapter.log.filter((c) => c === 'snapshot')).toHaveLength(1);
  client.clear();
});

test('with no query client it reads directly; an unreadable phone is null', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const adapter = fakeAdapter(snap());
  expect(await sharedPermissionSnapshot(null, 'u1', adapter, settings)).toEqual(snap());
  adapter.failReads = true;
  expect(await sharedPermissionSnapshot(null, 'u1', adapter, settings)).toBeNull();
  expect(SHARED_READ_MS).toBe(2_000);
});
