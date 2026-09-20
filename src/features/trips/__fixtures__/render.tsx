/**
 * The screen harness: a real sql.js database behind the same `Db` seam the device uses, the
 * app's own `QueryClient` defaults, the theme, and the two data providers — exactly what a
 * route mounts a screen inside. Nothing under `src/data` is mocked; only `expo-router` is,
 * and each suite declares that mock itself (Jest hoists `jest.mock` per file).
 */
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, type RenderResult } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { Db, DbResult, EventRow, TripRow } from '@/data/db';
import { createTestDb, seedDay, seedEvents, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { createQueryClient } from '@/data/queries/client';
import { ThemeProvider } from '@/ui/theme';

export interface Seed {
  trips?: readonly TripRow[];
  events?: readonly EventRow[];
  /** `[day, payload]` pairs for `score_daily_cache`. */
  days?: readonly [string, unknown][];
}

export interface ScreenWorld {
  db: Db;
  renderScreen(ui: ReactElement, over?: Db): Promise<RenderResult>;
}

/** Every client a screen was rendered with, so a suite can clear their gc timers when it is done. */
const clients = new Set<QueryClient>();

/**
 * Call from `afterEach`: an unobserved query keeps a five-minute gc timer, and a Jest worker
 * with one of those pending is reported as leaking.
 */
export function clearQueryClients(): void {
  for (const client of clients) client.clear();
  clients.clear();
}

export async function world(seed: Seed = {}, now: () => number = Date.now): Promise<ScreenWorld> {
  const db = await createTestDb();
  await seedTrips(db, seed.trips ?? []);
  if (seed.events?.length) await seedEvents(db, seed.events);
  for (const [day, payload] of seed.days ?? []) await seedDay(db, day, payload, now());

  return {
    db,
    async renderScreen(ui, over = db) {
      const client = createQueryClient();
      clients.add(client);
      const Data = wrapperFor(over, client, now);
      return render(
        <ThemeProvider>
          <Data>{ui}</Data>
        </ThemeProvider>
      );
    },
  };
}

export interface SlowDb extends Db {
  /**
   * Resolves once every read this wrapper delayed has finished. A screen mounts more queries
   * than the one a loading test looks at, and a read still in flight when the test returns
   * settles into a cache the `afterEach` has already cleared — leaving a fresh five-minute gc
   * timer behind and a Jest worker that will not exit. Await this before leaving the test.
   */
  idle(): Promise<void>;
}

/** A `Db` whose reads take `ms`, so a suite can look at the screen while it is still loading. */
export function slowDb(db: Db, ms: number): SlowDb {
  let pending: Promise<DbResult>[] = [];
  return {
    execute(sql, params) {
      const read = new Promise<DbResult>((resolve, reject) => {
        setTimeout(() => {
          db.execute(sql, params).then(resolve, reject);
        }, ms);
      });
      pending.push(read);
      return read;
    },
    transaction: (fn) => db.transaction(fn),
    async idle() {
      // A read that finishes can start the next one (a query enabled by the first), so drain
      // until a whole batch passes with nothing new behind it.
      while (pending.length > 0) {
        const batch = pending;
        pending = [];
        await Promise.allSettled(batch);
      }
    },
  };
}

/** A `Db` whose every statement fails, the way a corrupt file would. */
export function brokenDb(): Db {
  const fail = () => Promise.reject(new Error('SQLITE_CORRUPT: database disk image is malformed'));
  return { execute: fail, transaction: fail };
}

/**
 * Press, and wait for everything the press started.
 *
 * RNTL 14's `fireEvent.press` returns a promise. An un-awaited one breaks `act` for every later
 * test in the same worker and shows up as the *next* test hanging rather than this one failing,
 * so every press in this feature goes through here.
 */
export async function press(element: PressTarget): Promise<void> {
  await fireEvent.press(element);
}

/** Whatever RNTL 14's queries hand back — taken from `fireEvent` so the two never drift. */
export type PressTarget = Parameters<typeof fireEvent.press>[0];

/** The `useRouter()` double every screen suite installs. */
export function routerDouble() {
  return {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: jest.fn(() => true),
  };
}
