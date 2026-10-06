/**
 * The hook harness: a real SQLite (sql.js) behind the same `Db` seam the device uses, a real
 * `QueryClient` with the app's own defaults, and the two providers a screen renders inside.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import React from 'react';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createTripsRepo } from '@/data/db/trips';
import type { NewEvent, NewTrip } from '@/data/db/types';
import { DataProvider } from '@/data/queries/context';

export async function createTestDb(): Promise<Db> {
  const db = await createSqlJsDb();
  await migrate(db);
  return db;
}

export async function seedTrips(db: Db, rows: readonly NewTrip[], now = 1_700_000_000_000): Promise<void> {
  const trips = createTripsRepo(db);
  for (const row of rows) await trips.insert(row, now);
}

export async function seedEvents(db: Db, rows: readonly NewEvent[]): Promise<void> {
  await createEventsRepo(db).insertMany(rows);
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
