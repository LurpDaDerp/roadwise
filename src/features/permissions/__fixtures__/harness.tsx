/**
 * The permission surfaces' test world: the screen harness (real sql.js, the app's QueryClient,
 * theme), a drive host double inside a real drive store, a fake permissions adapter that logs
 * every OS call, and an AppState double the test can bring to the front.
 *
 * Each suite still declares its own `jest.mock`s (Jest hoists them per file): `expo-router`,
 * `@/data/supabase/session` and `@/data/supabase/profile`.
 */
import type { ReactElement } from 'react';

import type {
  Grant,
  LocationAccess,
  PermissionSnapshot,
  PermissionsAdapter,
  Readiness,
} from '@/core/permissions';
import { APP_CONFIG_KEY, type AppConfigRefresher, type StoredAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo, type TripRow } from '@/data/db';
import { T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { DriveContext } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { world } from '@/features/trips/__fixtures__/render';

export const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  platform: 'android',
  location: 'always',
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
  /** Every call in order: `snapshot`, `requestLocationAlways:firstDriveDone=true`, … */
  log: string[];
  /** What the next `snapshot()` returns. */
  current: PermissionSnapshot;
  /** Make `snapshot()` reject (a read failure). */
  failReads: boolean;
}

export function fakeAdapter(
  initial: PermissionSnapshot = snap(),
  answers: {
    always?: LocationAccess;
    foreground?: LocationAccess;
    motion?: Grant | null;
    readiness?: Readiness;
  } = {}
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
    requestLocationAlways: jest.fn(async ({ firstDriveDone }: { firstDriveDone: boolean }) => {
      a.log.push(`requestLocationAlways:firstDriveDone=${firstDriveDone}`);
      const next = answers.always ?? 'always';
      a.current = { ...a.current, location: next };
      return next;
    }),
    requestMotion: jest.fn(async () => {
      a.log.push('requestMotion');
      const next = answers.motion === undefined ? 'granted' : answers.motion;
      a.current = { ...a.current, motion: next };
      return next;
    }),
    requestNotifications: jest.fn(async () => {
      a.log.push('requestNotifications');
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
      return answers.readiness ?? { allowed: true, armed: true };
    }),
  };
  return a;
}

/**
 * A host that answers what these surfaces ask: the driver's auto-record choice, setting it, and
 * the published arming. `status` is deliberately independent of the choice, so a test can show a
 * screen reads `autoDetectEnabled()` and never `status === 'off'` (N-m2).
 */
export function fakeHost(opts: { intent?: boolean; status?: DriveState['status']; busy?: boolean } = {}) {
  let intent = opts.intent ?? false;
  let busy = opts.busy ?? false;
  let state = { status: opts.status ?? 'off', autoDetectArmed: false } as DriveState;
  const listeners = new Set<(s: DriveState) => void>();
  const publish = (next: Partial<DriveState>) => {
    state = { ...state, ...next };
    for (const fn of [...listeners]) fn(state);
  };
  const host = {
    snapshot: () => state,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    autoDetectEnabled: () => intent,
    setAutoDetect: jest.fn(async (enabled: boolean) => {
      intent = enabled;
    }),
    isBusy: () => busy,
    refreshArming: jest.fn(async () => {}),
  } as unknown as DriveHost;
  return {
    host,
    publish,
    setBusy(next: boolean) {
      busy = next;
    },
  };
}

export interface FakeAppState {
  currentState: string;
  addEventListener(type: 'change', fn: (s: string) => void): { remove(): void };
  /** Brings the app to the front: every listener hears `active`. */
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

/** A config refresher that never refreshes: the tests read only what they seed. */
export const noRefresh: AppConfigRefresher = { maybeRefresh: async () => false };

export const drive = (n: number, over: Partial<TripRow> = {}): TripRow =>
  tripRow({
    client_trip_id: `trip-${n}`,
    started_at: T0 + n * 3_600_000,
    sync_state: 'synced',
    created_at: T0 + n * 3_600_000,
    ...over,
  });

export interface Seed {
  trips?: readonly TripRow[];
  settings?: Record<string, unknown>;
  /** The `auto_detect` flag as the server last said; absent = never fetched (defaults). */
  autoDetect?: boolean;
}

export async function permissionsWorld(seed: Seed = {}) {
  const w = await world({ trips: seed.trips ?? [] });
  const settings = createSettingsRepo(w.db);
  for (const [key, value] of Object.entries(seed.settings ?? {})) await settings.set(key, value);
  if (seed.autoDetect !== undefined) {
    const stored: StoredAppConfig = { fetchedAt: T0, flags: { auto_detect: seed.autoDetect }, values: {} };
    await settings.set(APP_CONFIG_KEY, stored);
  }
  return {
    db: w.db,
    settings,
    render(ui: ReactElement, host: DriveHost) {
      const store = createDriveStore(host, {
        currentState: 'active',
        addEventListener: () => ({ remove() {} }),
      });
      return w.renderScreen(<DriveContext.Provider value={{ host, store }}>{ui}</DriveContext.Provider>);
    },
  };
}
