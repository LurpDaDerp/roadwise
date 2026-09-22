import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import {
  affirmationCovers,
  assessHealth,
  createPermissionsAdapter,
  DISCLOSURE_AFFIRMED_KEY,
  EVER_GRANTED_KEY,
  MANUAL_BY_CHOICE_KEY,
  nextEverGranted,
  type EverGranted,
  type HealthContext,
  type HealthReport,
  type PermissionSnapshot,
  type PermissionsAdapter,
  type SettingsStore,
} from '@/core/permissions';
import { useAppConfig, type UseAppConfigDeps } from '@/data/config/appConfig';
import { createSettingsRepo, type SettingsRepo } from '@/data/db';
import type { AppStateLike } from '@/data/foreground';
import { useDb, useTrips, type TripSummary } from '@/data/queries';
import { recordConsent } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';
import { DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';
import { useDrive, useDriveHost } from '@/drive/useDrive';

/**
 * A drive the driver made: a listed trip (the list already leaves out discarded and recording
 * rows) that was not ridden as a passenger or in someone else's vehicle.
 */
export function completedDrives(trips: readonly Pick<TripSummary, 'role'>[]): number {
  return trips.filter((t) => t.role === 'driver' || t.role === 'unknown').length;
}

let sharedAdapter: PermissionsAdapter | null = null;

/** The device adapter, made once. Importing it loads nothing native until a method is called. */
export function defaultPermissionsAdapter(): PermissionsAdapter {
  sharedAdapter ??= createPermissionsAdapter();
  return sharedAdapter;
}

// ─── The "back from B2's Open Settings" acknowledgement ─────────────────────────────────────────

/**
 * Set when B2 (or the disclosure) sends the driver to the phone's Settings; the next permission
 * report (Task 10's `reportPermissions`) takes it and sends `ack: true`, so a permission the driver
 * deliberately turned off there creates no lapse item.
 */
export const SETTINGS_RETURN_ACK_KEY = 'permissions.settingsReturnAck';

/** How long a trip to Settings counts as "launched from here". */
export const SETTINGS_RETURN_ACK_MS = 30 * 60 * 1000;

export async function markSettingsReturn(settings: Pick<SettingsStore, 'set'>, now: number): Promise<void> {
  await settings.set(SETTINGS_RETURN_ACK_KEY, now);
}

/**
 * Whether the report being made now follows a Settings trip launched from B2: true once, within
 * `SETTINGS_RETURN_ACK_MS` of it (a clock that moved back does not count). Always clears the mark.
 */
export async function takeSettingsReturnAck(
  settings: Pick<SettingsRepo, 'get' | 'remove'>,
  now: number
): Promise<boolean> {
  const at = await settings.get<unknown>(SETTINGS_RETURN_ACK_KEY);
  if (at === null) return false;
  await settings.remove(SETTINGS_RETURN_ACK_KEY);
  return typeof at === 'number' && Number.isFinite(at) && at <= now && now - at <= SETTINGS_RETURN_ACK_MS;
}

// ─── A background-location consent that could not be sent ──────────────────────────────────────

/**
 * A consent still owed to the server, `{ version, userId }`: set when Always was granted but
 * `recordConsent` failed (offline) or no session was left to send it under; cleared once sent.
 */
export const PENDING_DISCLOSURE_CONSENT_KEY = 'permissions.pendingDisclosureConsent';

export type RecordDisclosureConsent = (
  userId: string,
  consent: { type: 'background_location'; version: string }
) => Promise<unknown>;

/** A consent still owed, bound to the account that affirmed the disclosure (security M-1). */
export interface PendingDisclosureConsent {
  version: string;
  userId: string;
}

function parsePending(raw: unknown): PendingDisclosureConsent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { version, userId } = raw as Record<string, unknown>;
  return typeof version === 'string' && typeof userId === 'string' && userId !== ''
    ? { version, userId }
    : null;
}

/**
 * Records the background-location consent for the disclosure the driver just affirmed.
 *
 * The consent binds ONLY to `shownTo`, the account the disclosure screen was shown to (security
 * r1-M1):
 * - no such account, or a different account signed in now: nothing is recorded or kept;
 * - that account signed in now: sent under it; a failure (offline) is kept as
 *   `{ version, userId: shownTo }`, never dropped;
 * - no session now (lost mid-flow): nothing can be sent; kept bound to `shownTo`.
 *
 * Returns whether the consent was recorded now.
 */
export async function recordDisclosureConsent(
  settings: Pick<SettingsRepo, 'set' | 'remove'>,
  who: { shownTo: string | null; sessionUid: string | null },
  record: RecordDisclosureConsent = recordConsent
): Promise<boolean> {
  const { shownTo, sessionUid } = who;
  if (shownTo === null || (sessionUid !== null && sessionUid !== shownTo)) return false;
  const keep = () =>
    settings.set(PENDING_DISCLOSURE_CONSENT_KEY, {
      version: DISCLOSURE_VERSION,
      userId: shownTo,
    } satisfies PendingDisclosureConsent);
  if (sessionUid === null) {
    await keep();
    return false;
  }
  try {
    await record(shownTo, { type: 'background_location', version: DISCLOSURE_VERSION });
    await settings.remove(PENDING_DISCLOSURE_CONSENT_KEY);
    return true;
  } catch {
    await keep();
    return false;
  }
}

/**
 * Sends a consent `recordDisclosureConsent` could not — only under the account it is bound to
 * (security M-1). Under any other account it is neither sent nor removed: a different driver's
 * sign-in is a handover, whose wipe empties `settings` and drops it. A malformed record (no
 * account to bind it to) is removed unsent.
 */
export async function flushPendingDisclosureConsent(
  settings: Pick<SettingsRepo, 'get' | 'remove'>,
  sessionUid: string,
  record: RecordDisclosureConsent = recordConsent
): Promise<void> {
  const raw = await settings.get<unknown>(PENDING_DISCLOSURE_CONSENT_KEY);
  if (raw === null) return;
  const pending = parsePending(raw);
  if (pending === null) {
    await settings.remove(PENDING_DISCLOSURE_CONSENT_KEY);
    return;
  }
  if (pending.userId !== sessionUid) return;
  await record(sessionUid, { type: 'background_location', version: pending.version });
  await settings.remove(PENDING_DISCLOSURE_CONSENT_KEY);
}

// ─── The hook ───────────────────────────────────────────────────────────────────────────────────

export interface PermissionHealthDeps {
  adapter?: PermissionsAdapter;
  appState?: AppStateLike;
  /** Passed to `useAppConfig` (tests give it a refresher that never calls the network). */
  appConfig?: UseAppConfigDeps;
}

export type PermissionHealth =
  | { status: 'loading'; refresh: () => Promise<void> }
  | { status: 'error'; refresh: () => Promise<void> }
  | {
      status: 'ready';
      snapshot: PermissionSnapshot;
      report: HealthReport;
      context: HealthContext;
      refresh: () => Promise<void>;
    };

interface Read {
  snapshot: PermissionSnapshot;
  manualByChoice: boolean;
  everGranted: EverGranted;
  /** The raw stored affirmation, judged against the signed-in account below. */
  affirmation: unknown;
}

/**
 * The one read of the phone every health surface shares (Task 19 r1, review m2): Home's banner and
 * its status line — and B2 — observe the same query, so they can never show two different phones
 * (a read before and a read after a trip to Settings). Keyed by account, so a handover reads anew.
 */
export const permissionHealthKey = (uid: string | null) => ['permissions', 'health', uid ?? ''] as const;

/**
 * B2's model for the screen and the Home banner. The phone is read on mount and on every return
 * to the front (`AppState → active`) and when the caller asks (`refresh`, after a Fix) — never on
 * a timer, so an armed-idle phone costs nothing (design §3.5). Concurrent readers share one read.
 *
 * The context is the driver's, never guessed: auto-record from `host.autoDetectEnabled()` (the
 * choice, not the engine's status — N-m2), its availability from the `auto_detect` flag, the first
 * completed drive from the trip list, manual-by-choice, the ever-granted memory and this account's
 * disclosure affirmation from settings. A failed read is `status: 'error'`, not a made-up state.
 */
export function usePermissionHealth(deps: PermissionHealthDeps = {}): PermissionHealth {
  const adapter = deps.adapter ?? defaultPermissionsAdapter();
  const appState = deps.appState ?? AppState;
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const host = useDriveHost();
  const { profile, session } = useSession();
  const userId = session?.user.id ?? null;
  const { config } = useAppConfig(deps.appConfig);
  const trips = useTrips();
  // Re-render when the host arms or disarms, so the choice read below is current.
  useDrive((s) => s.autoDetectArmed === true);
  const queryClient = useQueryClient();
  const key = useMemo(() => permissionHealthKey(userId), [userId]);

  /** One read of the phone and the settings it is judged with; null when the phone can't be read. */
  const fetchRead = useCallback(async (): Promise<Read | null> => {
    try {
      const snapshot = await adapter.snapshot();
      const prev = (await settings.get<EverGranted>(EVER_GRANTED_KEY)) ?? {};
      const everGranted = nextEverGranted(prev, snapshot);
      if (everGranted !== prev) await settings.set(EVER_GRANTED_KEY, everGranted);
      const manualByChoice = (await settings.get<boolean>(MANUAL_BY_CHOICE_KEY)) === true;
      const affirmation = await settings.get<unknown>(DISCLOSURE_AFFIRMED_KEY);
      return { snapshot, manualByChoice, everGranted, affirmation };
    } catch {
      return null;
    }
  }, [adapter, settings]);

  const query = useQuery({
    queryKey: key,
    queryFn: fetchRead,
    // Read on mount of the first reader and on each return to the front — not again for a second
    // reader mounting beside it, which shares this read.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  const { refetch } = query;
  useEffect(() => {
    const sub = appState.addEventListener('change', (next) => {
      // Every reader hears the change; `cancelRefetch: false` joins the one read already started.
      if (next === 'active') void refetch({ cancelRefetch: false });
    });
    return () => sub.remove();
  }, [appState, refetch]);

  const read = query.data ?? null;
  const failed = query.isFetched && read === null && !query.isFetching;

  // A background-location consent the disclosure could not send (offline) goes when this is read.
  useEffect(() => {
    if (userId !== null) void flushPendingDisclosureConsent(settings, userId).catch(() => {});
  }, [settings, userId, read]);

  const refresh = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: key, exact: true });
  }, [queryClient, key]);

  if (failed) return { status: 'error', refresh };
  // A trip list that cannot be read counts as no drive yet: the stricter iOS reading (§5.3).
  const tripList = trips.data ?? (trips.isError ? [] : undefined);
  if (read === null || tripList === undefined) return { status: 'loading', refresh };

  const context: HealthContext = {
    drives: profile?.driving_stage !== 'non_driver',
    autoDetectOn: host.autoDetectEnabled(),
    autoDetectAvailable: config.flags.auto_detect,
    firstDriveDone: completedDrives(tripList) > 0,
    manualByChoice: read.manualByChoice,
    everGranted: read.everGranted,
    disclosureAffirmed: affirmationCovers(read.affirmation, userId),
  };
  return {
    status: 'ready',
    snapshot: read.snapshot,
    report: assessHealth(read.snapshot, context),
    context,
    refresh,
  };
}
