/**
 * Remote app config (design §3, the `app_config` table): the feature flags the server can switch
 * without a release — `auto_detect`, `camera_beta`, `referral`, `guardian_invites` — and the typed
 * rows onboarding and the rest of M4 read: the minimum app version, the minor-consent mode, the
 * legal document versions and URLs, the store links, the per-manufacturer battery guides and the
 * notification defaults.
 *
 * `refreshAppConfig` reads the public rows and keeps the validated flags and rows in device settings
 * under `APP_CONFIG_KEY` — one cache for all of it. `readFlag` and `readConfig` answer from there,
 * offline and instantly, with a compiled default for anything the server has not said or said in a
 * shape this build does not accept. The refresh is network work, so it is **not** part of the
 * launch: H2 runs it among the foreground jobs (throttled, only while the app is active — R13,
 * review I3), and `useAppConfig` may run it at most hourly while a screen that reads the config is
 * in front. A launch that has never fetched simply reads the defaults.
 *
 * A remote value only makes a feature available. Nothing here gates a safety behaviour, and a
 * background or privacy-affecting feature still needs the driver's own in-app opt-in.
 *
 * The config is public (`app_config_public` RLS: `is_public` rows, readable by anon), so it carries
 * no owner and needs no handover fence; a flag left from a previous driver is the same flag.
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

/** The server table, and the row inside it that holds the flags. */
export const APP_CONFIG_TABLE = 'app_config';
export const FEATURE_FLAGS_ROW = 'feature_flags';

export const FLAG_KEYS = ['auto_detect', 'camera_beta', 'referral', 'guardian_invites'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

// ---------------------------------------------------------------------------------------------
// The typed rows (Task 16). Each is validated as a whole: a row that fails its schema is the
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
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const batteryGuide = z.object({
  title: z.string().trim().min(1).max(80),
  steps: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
});

export const OEM_VENDORS = ['samsung', 'xiaomi', 'oneplus', 'google'] as const;
export type OemVendor = (typeof OEM_VENDORS)[number];

export const APP_CONFIG_SCHEMAS = {
  min_app_version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  minor_consent_mode: z.enum(['guardian_link_optional', 'guardian_consent_required']),
  onboarding: z.object({ tos_version: version, privacy_version: version }),
  legal_urls: z.object({
    terms: webUrl.optional(),
    privacy: webUrl.optional(),
  }),
  store_urls: z.object({
    ios: storeUrl.optional(),
    android: storeUrl.optional(),
  }),
  /** `default` is required, so there is always a guide to show; a vendor's own is optional. */
  oem_battery_guides: z.object({
    default: batteryGuide,
    samsung: batteryGuide.optional(),
    xiaomi: batteryGuide.optional(),
    oneplus: batteryGuide.optional(),
    google: batteryGuide.optional(),
  }),
  notification_defaults: z.object({
    quiet_enabled: z.boolean(),
    quiet_start: clock,
    quiet_end: clock,
    tz: z.string().trim().min(1).max(64),
  }),
} as const;

export type ConfigKey = keyof typeof APP_CONFIG_SCHEMAS;
export const CONFIG_KEYS = Object.keys(APP_CONFIG_SCHEMAS) as ConfigKey[];

export type ConfigValues = {
  [K in ConfigKey]: z.infer<(typeof APP_CONFIG_SCHEMAS)[K]>;
};
export type BatteryGuide = z.infer<typeof batteryGuide>;
export type MinorConsentMode = ConfigValues['minor_consent_mode'];

/** Everything a screen reads: the flags, every typed row, and when it was last fetched. */
export interface AppConfig extends ConfigValues {
  /** Epoch ms of the last successful refresh; null when this device has never fetched one. */
  fetchedAt: number | null;
  flags: Record<FlagKey, boolean>;
}

const guide = (title: string, ...steps: string[]): BatteryGuide => ({
  title,
  steps,
});

/**
 * What a device that has never fetched reads, equal to the values the migrations write: the flags
 * as 0005 leaves them (plus `guardian_invites: false`, which 0006 adds), and 0006's and 0007's
 * rows. `oem_battery_guides` here is the ONE source of the guide text (Ruling T16 (3)): 0006
 * carries it word for word, and a parity test parses the migration and holds it to this.
 */
export const CONFIG_DEFAULTS: Omit<AppConfig, 'fetchedAt'> = {
  // camera_beta and referral are off: a flag must not advertise a feature that is not built yet
  // (Ruling T16 (2); 0005 is amended to match).
  flags: {
    auto_detect: true,
    camera_beta: false,
    referral: false,
    guardian_invites: false,
  },
  min_app_version: '2.0.0',
  minor_consent_mode: 'guardian_link_optional',
  onboarding: { tos_version: '2026-09-21', privacy_version: '2026-09-21' },
  legal_urls: {},
  store_urls: {},
  oem_battery_guides: {
    samsung: guide(
      'Samsung: let RoadWise run in the background',
      'Open Settings, then Apps, then RoadWise.',
      'Tap Battery.',
      'Choose Unrestricted.',
      'In Settings, open Battery, then Background usage limits, and make sure RoadWise is not listed under Sleeping apps or Deep sleeping apps.'
    ),
    xiaomi: guide(
      'Xiaomi: let RoadWise run in the background',
      'Open Settings, then Apps, then Manage apps, then RoadWise.',
      'Tap Battery saver and choose No restrictions.',
      'Turn on Autostart.'
    ),
    oneplus: guide(
      'OnePlus: let RoadWise run in the background',
      'Open Settings, then Apps, then RoadWise.',
      'Tap Battery usage.',
      'Turn on Allow background activity, or choose Unrestricted.'
    ),
    google: guide(
      'Pixel: let RoadWise run in the background',
      'Open Settings, then Apps, then RoadWise.',
      'Tap App battery usage.',
      'Choose Unrestricted.'
    ),
    default: guide(
      'Let RoadWise run in the background',
      'Open Settings, then Apps, then RoadWise.',
      'Open its Battery settings. The name varies by phone.',
      'Choose Unrestricted, or turn off battery optimisation for RoadWise.'
    ),
  },
  notification_defaults: {
    quiet_enabled: true,
    quiet_start: '22:00',
    quiet_end: '07:00',
    tz: 'America/Los_Angeles',
  },
};

/** What is stored: only flags the server sent as booleans, and only rows that passed their schema. */
export interface StoredAppConfig {
  fetchedAt: number;
  flags: Partial<Record<FlagKey, boolean>>;
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

/** The boolean flags inside a `feature_flags` value; everything else in it is ignored. */
function pickFlags(value: unknown): StoredAppConfig['flags'] {
  const flags: StoredAppConfig['flags'] = {};
  if (!isRecord(value)) return flags;
  for (const key of FLAG_KEYS) {
    const v = value[key];
    if (typeof v === 'boolean') flags[key] = v;
  }
  return flags;
}

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
 * Fetch the public config and store its flags and typed rows, replacing what was stored: a flag
 * or row the server no longer sends goes back to its default rather than keeping a stale value.
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
    flags: pickFlags(rows.get(FEATURE_FLAGS_ROW)),
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
 * The stored value of `key`, or `fallback` when none was fetched or it cannot be read. The
 * fallback defaults to the compiled default (`guardian_invites` → false); a caller that passes its
 * own keeps D2's behaviour exactly.
 */
export async function readFlag(
  db: Db,
  key: FlagKey,
  fallback: boolean = CONFIG_DEFAULTS.flags[key]
): Promise<boolean> {
  try {
    const stored = await createSettingsRepo(db).get<unknown>(APP_CONFIG_KEY);
    if (!isRecord(stored) || !isRecord(stored.flags)) return fallback;
    const v = stored.flags[key];
    return typeof v === 'boolean' ? v : fallback;
  } catch {
    // A value this build cannot parse is the same as none: the fallback is the safe answer.
    return fallback;
  }
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
  const flags = pickFlags(record.flags);
  const values = isRecord(record.values) ? record.values : {};
  return {
    ...CONFIG_DEFAULTS,
    ...pickValues((key) => values[key]),
    flags: { ...CONFIG_DEFAULTS.flags, ...flags },
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
 * The app's refresh: the runtime's `refreshConfig`, which calls `refreshAppConfig` and re-applies
 * the host's arming when `auto_detect` changed, so Home and the host never disagree. Loaded
 * lazily, because the boot layer imports this module. Refused while a drive is under way, as the
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
 * at most hourly. No timer: an armed-idle phone in the background costs nothing (design §3.5).
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
