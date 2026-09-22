/**
 * The inbox screen harness: a real sql.js database (trips and the inbox cache), a server double
 * for the three inbox calls, and a network switch. Suites mock `expo-router`, the session and
 * the swipeable themselves (Jest hoists `jest.mock` per file).
 */
import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { TripRow } from '@/data/db/types';
import { setSharedNet, type NetAdapter } from '@/data/net/net';
import { createTestDb, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { T0 } from '@/data/queries/__fixtures__/rows';
import type { InboxApi, InboxRow } from '@/features/inbox/api';
import { createInboxCache } from '@/features/inbox/cache';
import { ThemeProvider } from '@/ui/theme';

import { iso } from './rows';

/** A server double: holds rows, logs calls in order, and can be told to fail. */
export function fakeApi(initial: InboxRow[] = []) {
  const log: string[] = [];
  const server = { rows: [...initial] };
  const fail: { fetch?: unknown; mark?: unknown; dismiss?: unknown } = {};
  const api: InboxApi = {
    fetchInbox: jest.fn(async () => {
      log.push('fetch');
      if (fail.fetch) throw fail.fetch;
      return server.rows.map((r) => ({ ...r }));
    }),
    markInboxRead: jest.fn(async (ids: readonly string[]) => {
      log.push(`read:${[...ids].join(',')}`);
      if (fail.mark) throw fail.mark;
      server.rows = server.rows.map((r) =>
        ids.includes(r.id) && !r.read_at ? { ...r, read_at: iso(T0) } : r
      );
      return ids.length;
    }),
    dismissInbox: jest.fn(async (ids: readonly string[]) => {
      log.push(`dismiss:${[...ids].join(',')}`);
      if (fail.dismiss) throw fail.dismiss;
      server.rows = server.rows.map((r) => (ids.includes(r.id) ? { ...r, dismissed_at: iso(T0) } : r));
      return ids.length;
    }),
  };
  return { api, log, server, fail };
}

/** Put the shared network adapter in a fixed state. `null` restores "assume online". */
export function setOnline(online: boolean | null): void {
  if (online === null) {
    setSharedNet(null);
    return;
  }
  const adapter: NetAdapter = {
    isOnline: () => online,
    isWifi: () => online,
    subscribe: () => () => undefined,
  };
  setSharedNet(adapter);
}

/** An AppState double whose `emit` delivers a change to every listener. */
export function fakeAppState(initial = 'active') {
  const listeners = new Set<(s: string) => void>();
  return {
    currentState: initial,
    addEventListener(_type: 'change', listener: (s: string) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit(state: string) {
      for (const l of [...listeners]) l(state);
    },
    count: () => listeners.size,
  };
}

const clients = new Set<QueryClient>();

/**
 * The app's query defaults, except that nothing is ever garbage-collected on a timer: a mutation or
 * a read that settles after a test has finished must not leave a five-minute timer behind (Jest
 * would not exit). `clearInboxClients` empties them in `afterEach`.
 */
export function testQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { gcTime: Infinity },
    },
  });
  clients.add(client);
  return client;
}

export function clearInboxClients(): void {
  for (const client of clients) client.clear();
  clients.clear();
}

/** A real database with `trips` and a cached inbox, and a render inside every provider. */
export async function inboxWorld(seed: { trips?: TripRow[]; cached?: InboxRow[] } = {}, now = () => T0) {
  const db = await createTestDb();
  await seedTrips(db, seed.trips ?? []);
  if (seed.cached) await createInboxCache(db).replaceAll(seed.cached);
  const client = testQueryClient();
  const Data = wrapperFor(db, client, now);
  return {
    db,
    client,
    render: (ui: ReactElement) =>
      render(
        <ThemeProvider>
          <Data>{ui}</Data>
        </ThemeProvider>
      ),
  };
}
