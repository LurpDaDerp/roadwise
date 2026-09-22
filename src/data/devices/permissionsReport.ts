/**
 * Reports this phone's permissions to its `devices` row, where 0007's lapse trigger turns a lost
 * permission into an inbox item (pushed when the report came from the background).
 *
 * - **Only on a change.** A report is written when the permissions fingerprint differs from the
 *   last one written for this account and install; the time, Low Power Mode and the can-ask-again
 *   flags never cause one.
 * - **The lapse baseline is never erased** (T8 r1 n1). A motion state that cannot be checked
 *   (`motion: null`) keeps the motion last reported, so a report whose only change is motion
 *   becoming unknown is no change at all, and a later real `granted → denied` is still a lapse.
 * - **Nothing made up.** The caller hands in a snapshot that was actually read; a failed read
 *   reports nothing (T8: `snapshot()` rejects rather than guess).
 * - **`everGranted`** (`EVER_GRANTED_KEY`) is updated with every snapshot, sent or not.
 * - **`ack`** is carried to the server. `'settingsReturn'` takes T9's mark from B2's Open Settings
 *   only when a report is actually written, and puts it back if that write fails, so the retry
 *   still says the change was the driver's own.
 *
 * `reportPermissionsFromBackground` is M3's wake hook (seam 3): with no change it touches neither
 * the session nor the network, so an armed, idle phone's wakes cost a local permission read.
 */
import {
  EVER_GRANTED_KEY,
  createPermissionsAdapter,
  nextEverGranted,
  permissionsFingerprint,
  toServerPermissions,
  type EverGranted,
  type PermissionSnapshot,
  type PermissionsAdapter,
  type ReportedFrom,
  type ServerPermissions,
} from '@/core/permissions';
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import type { Database } from '@/data/supabase/types';
import { markSettingsReturn, takeSettingsReturnAck } from '@/features/permissions/usePermissionHealth';
import { LOCAL_SENT_KEY } from '@/notifications/keys';

import { readInstallId } from './installId';
import { asError, noteReportedFingerprint, readLastUpsert, type DevicesClient } from './register';

export const REPORTED_PERMISSIONS_KEY = 'device.reportedPermissions';

type Settings = Pick<SettingsRepo, 'get' | 'set' | 'remove'>;

interface Reported {
  userId: string;
  deviceId: string;
  fingerprint: string;
  permissions: ServerPermissions;
}

export type ReportResult = 'reported' | 'unchanged' | 'no-device' | 'skipped' | 'error';

export interface ReportPermissionsInput {
  userId: string;
  deviceId: string;
  snapshot: PermissionSnapshot;
  reportedFrom: ReportedFrom;
  /** `'settingsReturn'`: true when this follows a Settings trip from B2 (T9's mark). */
  ack: boolean | 'settingsReturn';
}

export interface ReportPermissionsDeps {
  supabase: DevicesClient;
  settings: Settings;
  now: () => number;
  /**
   * Runs just before a report is written; false skips the write. The background path checks the
   * session here and sends the day's notification count (N-I1), only when there is something to send.
   */
  beforeWrite?: () => Promise<boolean>;
  onError?: (error: unknown, context: string) => void;
}

function parseReported(raw: unknown): Reported | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.userId !== 'string' ||
    typeof r.deviceId !== 'string' ||
    typeof r.fingerprint !== 'string' ||
    r.permissions === null ||
    typeof r.permissions !== 'object'
  ) {
    return null;
  }
  return r as unknown as Reported;
}

/** The permissions object last written for this account and install, if any. */
export async function readReportedPermissions(
  settings: Pick<SettingsRepo, 'get'>,
  userId: string,
  deviceId: string
): Promise<ServerPermissions | null> {
  const last = parseReported(await settings.get<unknown>(REPORTED_PERMISSIONS_KEY));
  return last && last.userId === userId && last.deviceId === deviceId ? last.permissions : null;
}

function isEverGranted(raw: unknown): raw is EverGranted {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

async function updateEverGranted(settings: Settings, snapshot: PermissionSnapshot): Promise<void> {
  const stored = await settings.get<unknown>(EVER_GRANTED_KEY);
  const prev: EverGranted = isEverGranted(stored) ? stored : {};
  const next = nextEverGranted(prev, snapshot);
  if (next !== prev) await settings.set(EVER_GRANTED_KEY, next);
}

export async function reportPermissions(
  input: ReportPermissionsInput,
  deps: ReportPermissionsDeps
): Promise<ReportResult> {
  const { userId, deviceId, snapshot, reportedFrom } = input;
  const { settings } = deps;
  await updateEverGranted(settings, snapshot);

  const last = await readReportedPermissions(settings, userId, deviceId);
  const next = toServerPermissions(snapshot, reportedFrom, false);
  // Unknown motion keeps the motion last reported (the server's lapse baseline).
  if (next.motion === undefined && last?.motion !== undefined) next.motion = last.motion;
  const fingerprint = permissionsFingerprint(next);
  if (last && permissionsFingerprint(last) === fingerprint) return 'unchanged';

  if (deps.beforeWrite && !(await deps.beforeWrite())) return 'skipped';

  let ack: boolean;
  if (input.ack === 'settingsReturn') {
    ack = await takeSettingsReturnAck(settings, deps.now());
  } else {
    ack = input.ack;
  }
  next.ack = ack;

  const restoreAck = async () => {
    if (input.ack === 'settingsReturn' && ack) await markSettingsReturn(settings, deps.now());
  };

  try {
    const { data, error } = await deps.supabase
      .from('devices')
      .update({
        permissions: next as unknown as Database['public']['Tables']['devices']['Update']['permissions'],
        last_seen_at: new Date(deps.now()).toISOString(),
      })
      .eq('user_id', userId)
      .eq('id', deviceId)
      .select('id');
    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0) {
      await restoreAck();
      return 'no-device';
    }
  } catch (error) {
    deps.onError?.(asError(error, 'permission report failed'), 'devices permissions report');
    await restoreAck();
    return 'error';
  }

  const record: Reported = { userId, deviceId, fingerprint, permissions: next };
  await settings.set(REPORTED_PERMISSIONS_KEY, record);
  await noteReportedFingerprint(settings, userId, deviceId, next);
  return 'reported';
}

// ─── From a background wake (M3 seam 3) ────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** T7's `{ day, count }` (LOCAL_SENT_KEY), or null when absent or unreadable. */
async function readDayCount(settings: Pick<SettingsRepo, 'get'>): Promise<{ day: string; count: number } | null> {
  const raw = await settings.get<unknown>(LOCAL_SENT_KEY);
  if (raw === null || typeof raw !== 'object') return null;
  const { day, count } = raw as Record<string, unknown>;
  if (typeof day !== 'string' || !DAY.test(day) || typeof count !== 'number' || !Number.isInteger(count)) {
    return null;
  }
  // the column's CHECK is 0..50; a count beyond it is still "capped"
  return { day, count: Math.min(Math.max(count, 0), 50) };
}

/**
 * N-I1: the only live server push in M4 is a lapse reported from a background wake — exactly when
 * a foreground-only count would be stale. So the count goes up first, where the push sweep reads
 * it. Only the two count columns are written (quiet hours stay null, so the defaults keep
 * applying); an update, then an insert when the account has no row yet.
 */
async function sendDayCount(
  supabase: DevicesClient,
  userId: string,
  settings: Pick<SettingsRepo, 'get'>
): Promise<void> {
  const count = await readDayCount(settings);
  if (!count) return;
  const values = { local_sent_day: count.day, local_sent_count: count.count };
  const update = async (): Promise<boolean> => {
    const { data, error } = await supabase
      .from('notification_prefs')
      .update(values)
      .eq('user_id', userId)
      .select('user_id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  };
  if (await update()) return;
  const inserted = await supabase.from('notification_prefs').insert({ user_id: userId, ...values });
  if (!inserted.error) return;
  // Review m3: another writer (T7's foreground sync) created the row between our update and our
  // insert. The row exists now, so the update is the right write; tried once.
  if (codeOf(inserted.error) === UNIQUE_VIOLATION && (await update())) return;
  throw inserted.error;
}

const UNIQUE_VIOLATION = '23505';

const codeOf = (error: unknown): string | null =>
  error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;

export interface BackgroundReportDeps {
  db: Db;
  /** Default: the app client, loaded on first use. */
  supabase?: DevicesClient;
  /** Default: the device adapter (it reads; it never prompts). */
  adapter?: Pick<PermissionsAdapter, 'snapshot'>;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

let defaultAdapter: PermissionsAdapter | null = null;

/**
 * For M3's wake handler (`BootstrapDeps.reportPermissionsFromBackground`): read the permissions
 * and, if they changed, report them as `reportedFrom: 'background'` (the lapse is then pushed).
 *
 * Runs only for the device's owner, with no handover pending, on an install the foreground has
 * already registered and reported from (so an account still onboarding reports nothing), and writes
 * only under a session that is that owner. Never throws.
 */
export async function reportPermissionsFromBackground(deps: BackgroundReportDeps): Promise<ReportResult> {
  const onError = deps.onError ?? (() => {});
  try {
    const settings = createSettingsRepo(deps.db);
    const owner = await settings.get<string>(LAST_USER_KEY);
    const pending = await settings.get<string>(PENDING_OWNER_KEY);
    if (typeof owner !== 'string' || (pending !== null && pending !== owner)) return 'skipped';
    const deviceId = await readInstallId(settings);
    if (deviceId === null || !(await readLastUpsert(settings, owner, deviceId))) return 'skipped';
    // The device row now exists from sign-in (the push token, security M-1); a foreground report
    // exists only once the account is onboarded, so an account still in setup reports nothing.
    if (!(await readReportedPermissions(settings, owner, deviceId))) return 'skipped';

    let snapshot: PermissionSnapshot;
    try {
      const adapter = deps.adapter ?? (defaultAdapter ??= createPermissionsAdapter());
      snapshot = await adapter.snapshot();
    } catch (error) {
      onError(error, 'devices background permissions snapshot');
      return 'skipped';
    }

    const supabase =
      deps.supabase ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when a report is due
      (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase;
    return await reportPermissions(
      { userId: owner, deviceId, snapshot, reportedFrom: 'background', ack: 'settingsReturn' },
      {
        supabase,
        settings,
        now: deps.now ?? Date.now,
        onError,
        beforeWrite: async () => {
          const { data } = await supabase.auth.getSession();
          if (data.session?.user.id !== owner) return false;
          try {
            await sendDayCount(supabase, owner, settings);
          } catch (error) {
            // the lapse matters more than the count: report it anyway
            onError(asError(error, 'day count failed'), 'devices day count');
          }
          return true;
        },
      }
    );
  } catch (error) {
    onError(error, 'devices background permissions report');
    return 'error';
  }
}

/**
 * The hook for `BootstrapDeps.reportPermissionsFromBackground`: wakes that arrive while a report
 * is running are folded into one more run after it, never run side by side.
 */
export function createBackgroundPermissionReporter(deps: BackgroundReportDeps): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      await reportPermissionsFromBackground(deps);
    } while (again);
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  };
}
