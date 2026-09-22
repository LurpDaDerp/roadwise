import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import {
  APP_CONFIG_KEY,
  APP_CONFIG_QUERY_KEY,
  APP_CONFIG_SCHEMAS,
  useAppConfig,
  type UseAppConfigDeps,
} from '@/data/config/appConfig';
import { useDb } from '@/data/queries';

/**
 * The forced-update gate's arithmetic. `required` is the only answer that moves anyone, and it is
 * given only when both versions are known and the app's is strictly older. Anything the app cannot
 * vouch for — no minimum ever fetched, a row that is absent or malformed, an app version it cannot
 * read — is `unknown`, and `unknown` never shows the update screen (offline or never-fetched: T16
 * review m3). A driver is never locked out of the app on a guess.
 */
export type UpdateStatus = 'required' | 'ok' | 'unknown';

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

function parse(version: string): [number, number, number] | null {
  const m = VERSION.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compares two `major.minor.patch` versions numerically (so `2.10.0` is newer than `2.9.0`).
 * Negative when `a` is older, positive when newer, 0 when equal; NaN when either is not a
 * `d.d.d` version, so no caller can mistake an unreadable version for an equal one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function updateStatus(
  appVersion: string | null | undefined,
  minVersion?: string | null
): UpdateStatus {
  if (typeof appVersion !== 'string' || typeof minVersion !== 'string') return 'unknown';
  const cmp = compareVersions(appVersion, minVersion);
  if (Number.isNaN(cmp)) return 'unknown';
  return cmp < 0 ? 'required' : 'ok';
}

/** This build's version, from the embedded app config; null when it cannot be read. */
export function currentAppVersion(): string | null {
  const version: unknown = Constants.expoConfig?.version;
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/**
 * The minimum version the server actually sent, or undefined. `readConfig` fills an absent row
 * with the compiled default, which is right for every other key and wrong for this one: a default
 * is not an instruction from the server. So the gate reads the stored row itself — present only
 * after a fetch, and only when it passed its schema — and re-validates it. Never rejects.
 */
export async function readServerMinAppVersion(db: Db): Promise<string | undefined> {
  try {
    const stored = await createSettingsRepo(db).get<unknown>(APP_CONFIG_KEY);
    if (typeof stored !== 'object' || stored === null) return undefined;
    const record = stored as { fetchedAt?: unknown; values?: unknown };
    if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return undefined;
    if (typeof record.values !== 'object' || record.values === null) return undefined;
    const raw = (record.values as Record<string, unknown>).min_app_version;
    const parsed = APP_CONFIG_SCHEMAS.min_app_version.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gate's answer for this build, or null until the cache has been read (so the launch router
 * can hold its frame rather than land somewhere and then move). Mounting it also keeps the config
 * fresh through `useAppConfig` (foreground only, at most hourly, refused mid-drive). The query key
 * sits under `APP_CONFIG_QUERY_KEY`, so every config write invalidates it too.
 */
export function useUpdateStatus(
  opts: { appVersion?: string | null; config?: UseAppConfigDeps } = {}
): UpdateStatus | null {
  const appVersion = opts.appVersion === undefined ? currentAppVersion() : opts.appVersion;
  const db = useDb();
  const { config, ready } = useAppConfig(opts.config);
  const query = useQuery({
    queryKey: [...APP_CONFIG_QUERY_KEY, 'min_app_version'],
    queryFn: async () => (await readServerMinAppVersion(db)) ?? null,
  });
  if (!ready || !query.isSuccess) return null;
  // A cache that was never fetched is unknown however it reads.
  if (config.fetchedAt === null) return 'unknown';
  return updateStatus(appVersion, query.data ?? undefined);
}
