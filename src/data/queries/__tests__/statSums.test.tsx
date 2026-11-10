import { renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';

import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { createTestDb, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { createQueryClient } from '@/data/queries/client';
import { useStatSums } from '@/data/queries/drives';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
let db: Db;
let client: QueryClient;

beforeEach(async () => {
  db = await createTestDb();
  client = createQueryClient();
  await seedTrips(db, [{ client_trip_id: uuid(1), started_at: T0 - 1000, tz: 'UTC', status: 'scored', miles: 10, duration_s: 600, clean: 1 }]);
});

afterEach(() => client.clear());

test('a rolling window that moves on the hour keeps its previous sums on screen until the new ones are read', async () => {
  const { result, rerender } = await renderHook(({ since }: { since: number }) => useStatSums(since), {
    wrapper: wrapperFor(db, client, () => T0),
    initialProps: { since: T0 - 7 * 24 * HOUR },
  });
  await waitFor(() => expect(result.current.data?.drives).toBe(1));
  await rerender({ since: T0 - 7 * 24 * HOUR + HOUR });
  // The new key has nothing read yet: the old sums stand in, never undefined.
  expect(result.current.data?.drives).toBe(1);
  await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  expect(result.current.data?.miles).toBe(10);
});
