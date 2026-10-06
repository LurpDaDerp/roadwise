/**
 * The test world for the screens in this area: an in-memory settings database, a fresh QueryClient
 * and the theme; a fake permissions adapter that logs every OS call; and an
 * AppState double the test can bring to the front.
 *
 * Each suite still declares its own `jest.mock`s (Jest hoists them per file): `expo-router`,
 * `@/data/supabase/session`, and `@/data/server/rpc` where the screen calls the server.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { Grant, LocationAccess, PermissionSnapshot, PermissionsAdapter, Readiness } from '@/core/permissions';
import type { Db, DbResult } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { DataProvider } from '@/data/queries/context';
import { ThemeProvider } from '@/ui/theme';

export const T0 = Date.UTC(2026, 9, 5, 15, 0, 0);

export const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  platform: 'android',
  location: 'foreground',
  precise: true,
  locationCanAskAgain: true,
  motion: 'granted',
  notifications: 'granted',
  notificationsCanAskAgain: true,
  batteryOptimization: 'exempt',
  lowPowerMode: false,
  checkedAt: T0,
  ...over,
});

export interface FakeAdapter extends PermissionsAdapter {
  /** Every call in order: `snapshot`, `requestLocationForeground`, … */
  log: string[];
  current: PermissionSnapshot;
  failReads: boolean;
}

export function fakeAdapter(
  initial: PermissionSnapshot = snap(),
  answers: { foreground?: LocationAccess; motion?: Grant | null; readiness?: Readiness } = {}
): FakeAdapter {
  const a: FakeAdapter = {
    log: [],
    current: initial,
    failReads: false,
    snapshot: jest.fn(async () => {
      a.log.push('snapshot');
      if (a.failReads) throw new Error('read failed');
      return a.current;
    }),
    requestLocationForeground: jest.fn(async () => {
      a.log.push('requestLocationForeground');
      const next = answers.foreground ?? 'foreground';
      a.current = { ...a.current, location: next };
      return next;
    }),
    requestLocationAlways: jest.fn(async () => {
      a.log.push('requestLocationAlways');
      return a.current.location;
    }),
    requestMotion: jest.fn(async () => {
      a.log.push('requestMotion');
      const next = answers.motion === undefined ? 'granted' : answers.motion;
      a.current = { ...a.current, motion: next };
      return next;
    }),
    requestNotifications: jest.fn(async () => {
      a.log.push('requestNotifications');
      a.current = { ...a.current, notifications: 'granted' };
      return 'granted' as const;
    }),
    openAppSettings: jest.fn(async () => {
      a.log.push('openAppSettings');
    }),
    openBatterySettings: jest.fn(async () => {
      a.log.push('openBatterySettings');
    }),
    readiness: jest.fn(async () => {
      a.log.push('readiness');
      return answers.readiness ?? { allowed: true, armed: false };
    }),
  };
  return a;
}

/**
 * Kept so step suites can pass "a host" as before; the world no longer mounts a drive. A screen
 * that reads the drive state mocks `@/drive/useDrive` in its own suite.
 */
export function fakeHost() {
  return { host: null };
}

export interface FakeAppState {
  currentState: string;
  addEventListener(type: 'change', fn: (s: string) => void): { remove(): void };
  foreground(): void;
  listeners(): number;
}

export function fakeAppState(): FakeAppState {
  const fns = new Set<(s: string) => void>();
  return {
    currentState: 'active',
    addEventListener: (_t, fn) => {
      fns.add(fn);
      return { remove: () => fns.delete(fn) };
    },
    foreground() {
      for (const fn of [...fns]) fn('active');
    },
    listeners: () => fns.size,
  };
}

/**
 * A `Db` that holds only the `settings` table, in memory: every screen in this area reads and
 * writes device settings and nothing else, so the tests don't depend on the drive tables.
 */
export function memoryDb(): Db & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const result = (rows: Record<string, unknown>[] = [], changes = 0): DbResult => ({ rows, changes });
  const db = {
    data,
    async execute(sql: string, params: unknown[] = []): Promise<DbResult> {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT value_json FROM settings WHERE key = \?$/.test(q)) {
        const v = data.get(String(params[0]));
        return result(v === undefined ? [] : [{ value_json: v }]);
      }
      if (/^INSERT OR REPLACE INTO settings/.test(q)) {
        data.set(String(params[0]), String(params[1]));
        return result([], 1);
      }
      if (/^DELETE FROM settings WHERE key = \?$/.test(q)) {
        return result([], data.delete(String(params[0])) ? 1 : 0);
      }
      if (/^SELECT key, value_json FROM settings/.test(q)) {
        const keys = /WHERE key IN/.test(q) ? params.map(String) : [...data.keys()].sort();
        return result(keys.filter((k) => data.has(k)).map((k) => ({ key: k, value_json: data.get(k) })));
      }
      throw new Error(`memoryDb: unsupported statement: ${q}`);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(db as unknown as Db);
    },
  };
  return db as unknown as Db & { data: Map<string, string> };
}

const clients = new Set<QueryClient>();

/** Call from `afterEach`: an unobserved query keeps a gc timer that holds the Jest worker open. */
export function clearQueryClients(): void {
  for (const c of clients) c.clear();
  clients.clear();
}

export interface AppWorld {
  db: Db;
  settings: ReturnType<typeof createSettingsRepo>;
  client: QueryClient;
  render(ui: ReactElement, host?: unknown): ReturnType<typeof render>;
}

/** A database (seeded with `settings`), a query client, and a render inside every provider. */
export async function appWorld(seed: { settings?: Record<string, unknown> } = {}): Promise<AppWorld> {
  const db = memoryDb();
  const settings = createSettingsRepo(db);
  for (const [k, v] of Object.entries(seed.settings ?? {})) await settings.set(k, v);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  clients.add(client);
  return {
    db,
    settings,
    client,
    render(ui) {
      return render(
        <ThemeProvider>
          <QueryClientProvider client={client}>
            <DataProvider db={db}>{ui}</DataProvider>
          </QueryClientProvider>
        </ThemeProvider>
      );
    },
  };
}

/** Finds, then presses inside one act: never a `waitFor` nested inside `act`. */
export async function tap(testID: string): Promise<void> {
  const el = await screen.findByTestId(testID, {}, { timeout: 3000 });
  await act(async () => {
    fireEvent.press(el);
  });
}

/** The server double the screen suites install: `mockRpc` answers by function name. */
type RpcArgs = Record<string, unknown> | undefined;
type RpcAnswer = ((args: RpcArgs) => unknown) | Error | null | boolean | number | string | object;
export type RpcAnswers = Record<string, RpcAnswer>;

export function answerRpc(mock: jest.Mock, answers: RpcAnswers): void {
  mock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
    if (!(fn in answers)) return null;
    const a = answers[fn];
    if (typeof a === 'function') return (a as (x: unknown) => unknown)(args);
    if (a instanceof Error) throw a;
    return a;
  });
}
