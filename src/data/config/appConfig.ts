/**
 * Remote app config (the `app_config` table): the typed rows the app reads — the minimum app
 * version (`min_app_version`, the update gate), the legal document versions (`onboarding`) and
 * URLs (`legal_urls`), and the store links (`store_urls`).
 *
 * `refreshAppConfig` reads the public rows and keeps the validated rows in device settings under
 * `APP_CONFIG_KEY`. `readConfig` answers from there, offline and instantly, with a compiled
 * default for anything the server has not said or said in a shape this build does not accept. The
 * refresh is network work, so it is **not** part of the launch: it runs among the foreground jobs
 * (throttled, only while the app is active), and `useAppConfig` may run it at most hourly while a
 * screen that reads the config is in front. A launch that has never fetched reads the defaults.
 *
 * The config is public (`app_config_public` RLS: `is_public` rows, readable by anon), so it carries
 * no owner and needs no handover fence.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { z } from 'zod';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { useDb } from '@/data/queries/context';

/** Settings key the fetched config is stored under. */
export const APP_CONFIG_KEY = 'config.app';

/** The server table. */
export const APP_CONFIG_TABLE = 'app_config';

// ---------------------------------------------------------------------------------------------
// The typed rows. Each is validated as a whole: a row that fails its schema is the
// compiled default, never half of one. Keys a schema does not name are dropped.
// ---------------------------------------------------------------------------------------------

const version = z.string().trim().min(1).max(64);
/** Only a web address can be opened by the in-app browser; `legalState` applies the same rule. */
const webUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\/[^\s/]+\S*$/i);
/** A store link: the web listing, or the store app's own scheme. */
const storeUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^(https:\/\/|itms-apps:\/\/|market:\/\/)\S+$/i);

export const APP_CONFIG_SCHEMAS = {
  min_app_version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  onboarding: z.object({ tos_version: version, privacy_version: version }),
  legal_urls: z.object({
    terms: webUrl.optional(),
    privacy: webUrl.optional(),
  }),
  store_urls: z.object({
    ios: storeUrl.optional(),
    android: storeUrl.optional(),
  }),
} as const;

export type ConfigKey = keyof typeof APP_CONFIG_SCHEMAS;
export const CONFIG_KEYS = Object.keys(APP_CONFIG_SCHEMAS) as ConfigKey[];

export type ConfigValues = {
  [K in ConfigKey]: z.infer<(typeof APP_CONFIG_SCHEMAS)[K]>;
};

/** Everything a screen reads: every typed row, and when it was last fetched. */
export interface AppConfig extends ConfigValues {
  /** Epoch ms of the last successful refresh; null when this device has never fetched one. */
  fetchedAt: number | null;
}

/** What a device that has never fetched reads; `min_app_version` equals 0001_core.sql's seed. */
export const CONFIG_DEFAULTS: Omit<AppConfig, 'fetchedAt'> = {
  min_app_version: '3.0.0',
  onboarding: { tos_version: '2026-09-21', privacy_version: '2026-09-21' },
  legal_urls: {},
  store_urls: {},
};

/** What is stored: only rows that passed their schema. */
export interface StoredAppConfig {
  fetchedAt: number;
  values: Partial<ConfigValues>;
}

/** The slice of `@supabase/supabase-js` the refresh uses. The app client is assignable (tested). */
export interface AppConfigSupabase {
  from(table: 'app_config'): {
    select(columns: 'key,value'): PromiseLike<{ data: unknown; error: unknown }>;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each known row that passes its schema, parsed; a missing or invalid row is simply absent. */
function pickValues(valueOf: (key: ConfigKey) => unknown): Partial<ConfigValues> {
  const values: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const parsed = APP_CONFIG_SCHEMAS[key].safeParse(valueOf(key));
    if (parsed.success) values[key] = parsed.data;
  }
  return values as Partial<ConfigValues>;
}

/**
 * Fetch the public config and store its typed rows, replacing what was stored: a row the server
 * no longer sends goes back to its default rather than keeping a stale value.
 * Rejects — storing nothing — when the request fails or the answer is not a list of rows, so a
 * throttled foreground job tries again next time instead of stamping a failure as done.
 */
export function refreshAppConfig(
  supabase: AppConfigSupabase,
  db: Db,
  now: () => number = Date.now
): Promise<void> {
  // One request at a time per database (review m2): the daily foreground job and a screen's hourly
  // refresh can both fire on the same return to the front, and they share this one fetch.
  const running = inFlightRefresh.get(db);
  if (running) return running;
  const run = fetchAndStore(supabase, db, now).finally(() => inFlightRefresh.delete(db));
  inFlightRefresh.set(db, run);
  return run;
}

const inFlightRefresh = new Map<Db, Promise<void>>();
const writeListeners = new Set<() => void>();

/**
 * Called after every write of `APP_CONFIG_KEY`, whichever path made it (review m1), so a screen
 * already showing the config re-reads it. Returns the unsubscribe.
 */
export function onAppConfigWritten(fn: () => void): () => void {
  writeListeners.add(fn);
  return () => {
    writeListeners.delete(fn);
  };
}

async function fetchAndStore(
  supabase: AppConfigSupabase,
  db: Db,
  now: () => number
): Promise<void> {
  const { data, error } = await supabase.from(APP_CONFIG_TABLE).select('key,value');
  if (error) throw new Error(`app config: the request failed (${describe(error)})`);
  if (!Array.isArray(data)) throw new Error('app config: the answer was not a list of rows');

  const rows = new Map<unknown, unknown>();
  for (const r of data as unknown[]) if (isRecord(r) && !rows.has(r.key)) rows.set(r.key, r.value);
  const stored: StoredAppConfig = {
    fetchedAt: now(),
    values: pickValues((key) => rows.get(key)),
  };
  await createSettingsRepo(db).set(APP_CONFIG_KEY, stored);
  for (const fn of [...writeListeners]) {
    try {
      fn();
    } catch {
      // A listener's failure is its own; the config is stored.
    }
  }
}

/**
 * A refresh that did not run because now is the wrong moment — the launch is still booting, or a
 * drive is under way. It is not an attempt: the throttle is not stamped, so the next return to
 * the front tries again (review m1).
 */
export class AppConfigRefreshRefused extends Error {
  override readonly name = 'AppConfigRefreshRefused';
}

/**
 * The whole config from the cache, every value re-checked (the stored JSON may have been written
 * by another build). Never rejects: anything missing, invalid or unreadable is its default.
 */
export async function readConfig(db: Db): Promise<AppConfig> {
  let stored: unknown = null;
  try {
    stored = await createSettingsRepo(db).get<unknown>(APP_CONFIG_KEY);
  } catch {
    stored = null;
  }
  const record = isRecord(stored) ? stored : {};
  const values = isRecord(record.values) ? record.values : {};
  return {
    ...CONFIG_DEFAULTS,
    ...pickValues((key) => values[key]),
    fetchedAt:
      typeof record.fetchedAt === 'number' && Number.isFinite(record.fetchedAt)
        ? record.fetchedAt
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The screen hook.
// ---------------------------------------------------------------------------------------------

/** The hook refreshes at most this often, and only when the stored config is at least this old. */
export const APP_CONFIG_REFRESH_INTERVAL_MS = 60 * 60_000;

/** The query the hook reads the cache through; invalidate it after writing `APP_CONFIG_KEY`. */
export const APP_CONFIG_QUERY_KEY = ['settings', APP_CONFIG_KEY] as const;

export interface AppConfigRefresher {
  /**
   * Run `refresh` when it is due: the stored config is an interval old (or was never fetched)
   * and no attempt that ran — successful or failed — was made within the interval. A refusal
   * (`AppConfigRefreshRefused`: booting, mid-drive) is not an attempt and is not stamped. Callers
   * arriving while an attempt is running share it. Resolves true only when a refresh ran and
   * succeeded; never rejects.
   */
  maybeRefresh(db: Db, refresh: () => Promise<void>, now: () => number): Promise<boolean>;
}

export function createAppConfigRefresher(
  intervalMs: number = APP_CONFIG_REFRESH_INTERVAL_MS
): AppConfigRefresher {
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<boolean> | null = null;
  /** Due when never done, an interval ago, or "in the future" (a clock set back must not stick). */
  const due = (at: number | null, t: number) => at === null || t - at >= intervalMs || t < at;

  return {
    maybeRefresh(db, refresh, now) {
      if (inFlight) return inFlight;
      if (!due(lastAttemptAt, now())) return Promise.resolve(false);
      const attempt = (async () => {
        try {
          const { fetchedAt } = await readConfig(db);
          const t = now();
          if (!due(fetchedAt, t) || !due(lastAttemptAt, t)) return false;
          try {
            await refresh();
          } catch (error) {
            // A refusal (booting, mid-drive) is not an attempt and leaves no stamp; a request that
            // ran and failed (offline) waits an interval, as a success does.
            if (!(error instanceof AppConfigRefreshRefused)) lastAttemptAt = t;
            return false;
          }
          lastAttemptAt = t;
          return true;
        } catch {
          // The cache could not be read: nothing ran, so nothing is stamped.
          return false;
        } finally {
          inFlight = null;
        }
      })();
      inFlight = attempt;
      return attempt;
    },
  };
}

/** The defaults as a config that was never fetched: one object, so `config` is referentially stable. */
const DEFAULT_CONFIG: AppConfig = { ...CONFIG_DEFAULTS, fetchedAt: null };

/** The app's one refresher, shared by every mounted `useAppConfig`. */
const sharedRefresher = createAppConfigRefresher();

/**
 * The app's refresh: the runtime's `refreshConfig`, which calls `refreshAppConfig`. Loaded lazily, because the boot layer imports this module. Refused while a drive is under way, as the
 * foreground job refuses it.
 */
async function runtimeRefresh(): Promise<void> {
  const { getRuntimeState } = await import('@/boot/controller');
  const runtime = getRuntimeState().runtime;
  if (runtime === null) throw new AppConfigRefreshRefused('app config: no runtime yet');
  if (runtime.drive.isBusy()) throw new AppConfigRefreshRefused('app config: a drive is under way');
  await runtime.refreshConfig();
}

export interface UseAppConfigDeps {
  /** Defaults to the runtime's `refreshConfig` (through `refreshAppConfig`). */
  refresh?: () => Promise<void>;
  refresher?: AppConfigRefresher;
  appState?: AppStateLike;
  now?: () => number;
}

/**
 * The config for a screen. `config` is the compiled defaults until the cache has been read
 * (`ready` false), then the cached config. While the app is in front — on mount, and on every
 * return to the front — it refreshes through `refreshAppConfig` when the cache is an hour old,
 * at most hourly. No timer: nothing runs in the background.
 */
export function useAppConfig(deps: UseAppConfigDeps = {}): {
  config: AppConfig;
  ready: boolean;
} {
  const {
    refresh = runtimeRefresh,
    refresher = sharedRefresher,
    appState = AppState,
    now = Date.now,
  } = deps;
  const db = useDb();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: APP_CONFIG_QUERY_KEY,
    queryFn: () => readConfig(db),
  });

  // Any write of the cache — this hook's refresh or the daily foreground job's — is shown at once.
  useEffect(
    () =>
      onAppConfigWritten(() => {
        void client.invalidateQueries({ queryKey: APP_CONFIG_QUERY_KEY });
      }),
    [client]
  );

  useEffect(() => {
    const attempt = () => {
      void refresher.maybeRefresh(db, refresh, now);
    };
    if (appState.currentState === 'active') attempt();
    const subscription = appState.addEventListener('change', (next) => {
      if (next === 'active') attempt();
    });
    return () => subscription.remove();
  }, [db, refresh, refresher, appState, now]);

  return { config: query.data ?? DEFAULT_CONFIG, ready: query.isSuccess };
}

function describe(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message.slice(0, 120);
  return 'unknown error';
}
