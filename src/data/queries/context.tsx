/**
 * The seam the hooks read the database through.
 *
 * The hooks take no `db` argument: a screen should ask for "this trip", not for "this trip out of
 * that database". The host opens SQLite once at launch (after `migrate` and crash recovery) and
 * puts it here; a test puts a sql.js database here instead, and the hooks cannot tell.
 *
 * `now` is part of the seam for the same reason: `useInsights` needs an instant to place its
 * window, and a test that pinned `Date.now` globally would pin it for React Query's own timers
 * too.
 */
import React, { createContext, useContext, useMemo } from 'react';

import type { Db } from '@/data/db/driver';

export interface DataSource {
  db: Db;
  /** The clock the aggregations date their windows from. Defaults to `Date.now`. */
  now: () => number;
}

const DataContext = createContext<DataSource | null>(null);

export function DataProvider({
  db,
  now,
  children,
}: {
  db: Db;
  now?: () => number;
  children: React.ReactNode;
}) {
  const value = useMemo<DataSource>(() => ({ db, now: now ?? (() => Date.now()) }), [db, now]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useDataSource(): DataSource {
  const value = useContext(DataContext);
  if (value === null) {
    throw new Error('useDataSource: wrap the tree in <DataProvider db={…}> before reading data');
  }
  return value;
}

export function useDb(): Db {
  return useDataSource().db;
}
