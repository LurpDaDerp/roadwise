/**
 * The screen harness for the insight suites: a real sql.js database behind the same `Db` seam the
 * device uses, the app's own `QueryClient` defaults, the theme, and the two data providers —
 * exactly what a route mounts a screen inside. Nothing under `src/data` is mocked; only
 * `expo-router` is, and each suite declares that mock itself (Jest hoists `jest.mock` per file).
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import type { TripRow } from '@/data/db/types';
import {
  createTestDb,
  seedDay,
  seedTrips,
  wrapperFor,
} from '@/data/queries/__fixtures__/harness';
import { createQueryClient } from '@/data/queries/client';
import { ThemeProvider } from '@/ui/theme';

export interface Seed {
  trips?: readonly TripRow[];
  /** `[day, payload]` pairs for `score_daily_cache`. */
  days?: readonly [string, unknown][];
  /** Device-local preferences, e.g. `['camera.mode', true]`. */
  settings?: readonly [string, unknown][];
}

export interface ScreenWorld {
  db: Db;
  renderScreen(ui: ReactElement, over?: Db): Promise<RenderResult>;
}

/** Every client a screen was rendered with, so a suite can clear their gc timers when it is done. */
const clients = new Set<QueryClient>();

/**
 * Call from `afterEach`: an unobserved query keeps a five-minute gc timer, and a Jest worker with
 * one of those pending is reported as leaking.
 */
export function clearQueryClients(): void {
  for (const client of clients) client.clear();
  clients.clear();
}

export async function world(seed: Seed = {}, now: () => number = Date.now): Promise<ScreenWorld> {
  const db = await createTestDb();
  await seedTrips(db, seed.trips ?? []);
  for (const [day, payload] of seed.days ?? []) await seedDay(db, day, payload, now());
  for (const [key, value] of seed.settings ?? []) await createSettingsRepo(db).set(key, value);

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

/** A `Db` whose reads take `ms`, so a suite can look at the screen while it is still loading. */
export function slowDb(db: Db, ms: number): Db {
  return {
    execute: (sql, params) =>
      new Promise((resolve, reject) => {
        setTimeout(() => db.execute(sql, params).then(resolve, reject), ms);
      }),
    transaction: (fn) => db.transaction(fn),
  };
}

/** A `Db` whose every statement fails, the way a corrupt file would. */
export function brokenDb(): Db {
  const fail = () => Promise.reject(new Error('SQLITE_CORRUPT: database disk image is malformed'));
  return { execute: fail, transaction: fail };
}

/**
 * Press, and let React finish.
 *
 * RNTL 14's `fireEvent` is asynchronous and act-wrapped, so a press that is not awaited leaves the
 * pressable's own state update pending — which breaks `act` for every later test in the worker,
 * and shows up as the *next* test hanging rather than this one failing. Wrapped here so no call
 * site can forget.
 */
export async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await fireEvent.press(element);
}

/**
 * Let the reads that a press started land.
 *
 * React Query notifies its observers on a macrotask, and an `act` scope defers that, so a
 * `waitFor` opened straight after a press can poll a tree that React is not allowed to update.
 * One turn of the event loop *inside* `act` lets the notify through, and the assertion after it
 * is an ordinary synchronous read of the settled screen.
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The `useRouter()` double every screen suite installs. */
export function routerDouble() {
  return {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    setParams: jest.fn(),
    canGoBack: jest.fn(() => true),
  };
}
