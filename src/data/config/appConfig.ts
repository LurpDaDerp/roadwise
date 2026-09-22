/**
 * Remote app config (design §3, the `app_config` table): the feature flags the server can switch
 * without a release — `auto_detect`, `camera_beta`, `referral`.
 *
 * `refreshAppConfig` reads the public rows and keeps the validated flags in device settings under
 * `APP_CONFIG_KEY`; `readFlag` answers from there, offline and instantly, with the caller's
 * fallback for anything the server has not said. The refresh is network work, so it is **not**
 * part of the launch: H2 runs it among the foreground jobs (throttled, only while the app is
 * active — R13, review I3). A launch that has never fetched simply reads every flag's fallback.
 *
 * The config is public (`app_config_public` RLS: `is_public` rows, readable by anon), so it carries
 * no owner and needs no handover fence; a flag left from a previous driver is the same flag.
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';

/** Settings key the fetched config is stored under. */
export const APP_CONFIG_KEY = 'config.app';

/** The server table, and the row inside it that holds the flags. */
export const APP_CONFIG_TABLE = 'app_config';
export const FEATURE_FLAGS_ROW = 'feature_flags';

export const FLAG_KEYS = ['auto_detect', 'camera_beta', 'referral'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/** What is stored: only flags the server sent as booleans; anything else is left to the fallback. */
export interface StoredAppConfig {
  fetchedAt: number;
  flags: Partial<Record<FlagKey, boolean>>;
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

/**
 * Fetch the public config and store its flags, replacing what was stored: a flag the server no
 * longer sends goes back to each caller's fallback rather than keeping a stale value. Rejects —
 * storing nothing — when the request fails or the answer is not a list of rows, so a throttled
 * foreground job tries again next time instead of stamping a failure as done.
 */
export async function refreshAppConfig(
  supabase: AppConfigSupabase,
  db: Db,
  now: () => number = Date.now
): Promise<void> {
  const { data, error } = await supabase.from(APP_CONFIG_TABLE).select('key,value');
  if (error) throw new Error(`app config: the request failed (${describe(error)})`);
  if (!Array.isArray(data)) throw new Error('app config: the answer was not a list of rows');

  const row = data.find((r: unknown) => isRecord(r) && r.key === FEATURE_FLAGS_ROW) as
    | Record<string, unknown>
    | undefined;
  const stored: StoredAppConfig = { fetchedAt: now(), flags: pickFlags(row?.value) };
  await createSettingsRepo(db).set(APP_CONFIG_KEY, stored);
}

/** The stored value of `key`, or `fallback` when none was fetched or it cannot be read. */
export async function readFlag(db: Db, key: FlagKey, fallback: boolean): Promise<boolean> {
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

function describe(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message.slice(0, 120);
  return 'unknown error';
}
