/**
 * Which kinds of drive the phone holds archived (183 days after they ended: in no list, still in
 * every total). Drive history reads it so an empty list says "in the last 6 months" rather than
 * "yet" when older drives exist: any drive (All), a clean one (Clean), a "Wasn't driving" one
 * (Passenger), the same kinds its filters list.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { asNumber } from '@/data/db/row';
import { useDataSource } from '@/data/queries/context';
import { queryKeys } from '@/data/queries/keys';

export interface ArchivedKinds {
  all: boolean;
  clean: boolean;
  passenger: boolean;
}

export async function readArchivedKinds(db: Db): Promise<ArchivedKinds> {
  const { rows } = await db.execute(
    `SELECT EXISTS (SELECT 1 FROM trips WHERE archived_at IS NOT NULL) AS a,
            EXISTS (SELECT 1 FROM trips WHERE archived_at IS NOT NULL AND clean = 1) AS c,
            EXISTS (SELECT 1 FROM trips WHERE archived_at IS NOT NULL AND status = 'not_driving') AS p`
  );
  const row = rows[0] ?? {};
  return { all: asNumber(row, 'a') !== 0, clean: asNumber(row, 'c') !== 0, passenger: asNumber(row, 'p') !== 0 };
}

export function useArchivedKinds(): UseQueryResult<ArchivedKinds> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.archivedKinds(), queryFn: () => readArchivedKinds(db) });
}
