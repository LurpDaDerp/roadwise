/**
 * The `devices` row for this install: who the phone is, which app version it runs, and the
 * permission object last reported for it.
 *
 * Only the columns below are ever sent (never `drive_state`, which the reporter owns, nor
 * `drive_state_at`, which the server stamps, nor the legacy `push_token`, nor `synced_through`, the
 * sync watermark's own; `signed_out_at` is always sent as null — M5 R-A). The write is throttled
 * to once every 6 hours (rev1: O3), unless the app version or the permissions fingerprint changed:
 * `last_seen_at` needs no more than that, and a foreground costs no request it does not need.
 *
 * `permissions` is only ever the object `reportPermissions` last wrote for this account and
 * install (or left out when nothing was reported yet), so an upsert never moves the lapse
 * trigger's baseline: a change of permission is `reportPermissions`' job alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import { permissionsFingerprint, type ServerPermissions } from '@/core/permissions';
import type { SettingsRepo } from '@/data/db/settings';
import type { Database } from '@/data/supabase/types';

/** The app's Supabase client, as this module uses it. */
export type DevicesClient = SupabaseClient<Database>;

export const LAST_UPSERT_KEY = 'device.lastUpsert';
export const UPSERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The columns' own bound (0001: `char_length(...) <= 64`). */
const MAX_TEXT = 64;

export interface BaseDeviceInfo {
  platform: 'ios' | 'android';
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
}

export interface DeviceInfo extends BaseDeviceInfo {
  /** The object last reported for this account and install; null/absent: not sent. */
  permissions?: ServerPermissions | null;
}

interface LastUpsert {
  userId: string;
  deviceId: string;
  at: number;
  appVersion: string | null;
  fingerprint: string | null;
}

export type UpsertResult = 'saved' | 'throttled' | 'error';

export interface UpsertDeps {
  supabase: DevicesClient;
  settings: Pick<SettingsRepo, 'get' | 'set'>;
  deviceId: string;
  now: () => number;
  onError?: (error: unknown, context: string) => void;
}

const clip = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;

/**
 * The phone's model, OS and app version. Null on a platform the server does not know (web).
 * expo-device and expo-constants are loaded here, on first use, not at import.
 */
export function readDeviceInfo(): BaseDeviceInfo | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  /* eslint-disable @typescript-eslint/no-require-imports -- native modules, loaded on first use */
  const Device = require('expo-device') as typeof import('expo-device');
  const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    platform: Platform.OS,
    model: clip(Device.modelName),
    osVersion: clip(Device.osVersion),
    appVersion: clip(Constants.expoConfig?.version),
  };
}

function parseLast(raw: unknown): LastUpsert | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || typeof r.deviceId !== 'string' || typeof r.at !== 'number') return null;
  return {
    userId: r.userId,
    deviceId: r.deviceId,
    at: r.at,
    appVersion: typeof r.appVersion === 'string' ? r.appVersion : null,
    fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : null,
  };
}

/** The last successful upsert, if it was for this account and install. */
export async function readLastUpsert(
  settings: Pick<SettingsRepo, 'get'>,
  userId: string,
  deviceId: string
): Promise<LastUpsert | null> {
  const last = parseLast(await settings.get<unknown>(LAST_UPSERT_KEY));
  return last && last.userId === userId && last.deviceId === deviceId ? last : null;
}

/**
 * A permission report has just written `permissions` (and `last_seen_at`) to the row: the
 * throttle's fingerprint moves with it, so the next upsert does not send the same object again.
 */
export async function noteReportedFingerprint(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
  userId: string,
  deviceId: string,
  permissions: ServerPermissions
): Promise<void> {
  const last = await readLastUpsert(settings, userId, deviceId);
  if (!last) return;
  await settings.set(LAST_UPSERT_KEY, { ...last, fingerprint: permissionsFingerprint(permissions) });
}

/** Upsert this install's row for `userId`, at most every 6 hours unless something that matters changed. */
export async function upsertDevice(userId: string, info: DeviceInfo, deps: UpsertDeps): Promise<UpsertResult> {
  const { settings, deviceId } = deps;
  const now = deps.now();
  const fingerprint = info.permissions ? permissionsFingerprint(info.permissions) : null;
  const last = await readLastUpsert(settings, userId, deviceId);
  if (
    last &&
    last.appVersion === info.appVersion &&
    last.fingerprint === fingerprint &&
    // a clock that moved back does not keep the throttle shut
    last.at <= now &&
    now - last.at < UPSERT_INTERVAL_MS
  ) {
    return 'throttled';
  }

  const row = {
    id: deviceId,
    user_id: userId,
    platform: info.platform,
    model: info.model,
    os_version: info.osVersion,
    app_version: info.appVersion,
    last_seen_at: new Date(now).toISOString(),
    // M5 R-A: a phone signed in again speaks for its owner again, so it holds their reward days
    // until its next clean drain reports a watermark (`syncWatermark.ts` writes `signed_out_at` at
    // sign-out, and removes this throttle's stamp so the next sign-in's upsert is not skipped).
    signed_out_at: null,
    ...(info.permissions ? { permissions: info.permissions as unknown as Database['public']['Tables']['devices']['Insert']['permissions'] } : {}),
  };
  try {
    const { error } = await deps.supabase.from('devices').upsert(row, { onConflict: 'user_id,id' });
    if (error) throw error;
  } catch (error) {
    deps.onError?.(asError(error, 'device upsert failed'), 'devices upsert');
    return 'error';
  }
  const stamp: LastUpsert = { userId, deviceId, at: now, appVersion: info.appVersion, fingerprint };
  await settings.set(LAST_UPSERT_KEY, stamp);
  return 'saved';
}

/** A PostgREST error object as an `Error`, carrying its code only (never a row or a token). */
export function asError(error: unknown, message: string): Error {
  if (error instanceof Error) return error;
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  return new Error(code ? `${message} (${code})` : message);
}
