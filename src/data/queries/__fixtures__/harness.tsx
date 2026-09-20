/**
 * The hook harness: a real SQLite (sql.js) behind the same `Db` seam the device uses, a real
 * `QueryClient` with the app's own defaults, and the two providers a screen renders inside.
 *
 * Nothing is mocked. A hook test here exercises the repositories, the SQL and the aggregations
 * exactly as a screen will.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import React from 'react';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createTripsRepo } from '@/data/db/trips';
import type { EventRow, TripRow } from '@/data/db/types';
import { DataProvider } from '@/data/queries/context';

export async function createTestDb(): Promise<Db> {
  const db = await createSqlJsDb();
  await migrate(db);
  return db;
}

export async function seedTrips(db: Db, rows: readonly TripRow[]): Promise<void> {
  const trips = createTripsRepo(db);
  for (const row of rows) await trips.insert(row, row.created_at);
}

export async function seedEvents(db: Db, rows: readonly EventRow[]): Promise<void> {
  await createEventsRepo(db).insertMany(rows);
}

export async function seedDay(db: Db, day: string, payload: unknown, at: number): Promise<void> {
  await createScoreDailyCacheRepo(db).put(day, payload, at);
}

export function wrapperFor(db: Db, client: QueryClient, now: () => number) {
  return function Harness({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <DataProvider db={db} now={now}>
          {children}
        </DataProvider>
      </QueryClientProvider>
    );
  };
}
