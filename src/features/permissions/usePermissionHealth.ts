import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  assessHealth,
  createPermissionsAdapter,
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
 * The disclosure version whose consent is still owed to the server: set when Always was granted
 * but `recordConsent` failed (offline), cleared once it is sent.
 */
export const PENDING_DISCLOSURE_CONSENT_KEY = 'permissions.pendingDisclosureConsent';

export type RecordDisclosureConsent = (
  userId: string,
  consent: { type: 'background_location'; version: string }
) => Promise<unknown>;

/**
 * Records the background-location consent for the disclosure the driver just affirmed. A failure
 * is kept (never dropped) and sent by `flushPendingDisclosureConsent` on a later read.
 */
export async function recordDisclosureConsent(
  settings: Pick<SettingsRepo, 'set' | 'remove'>,
  userId: string,
  record: RecordDisclosureConsent = recordConsent
): Promise<boolean> {
  try {
    await record(userId, { type: 'background_location', version: DISCLOSURE_VERSION });
    await settings.remove(PENDING_DISCLOSURE_CONSENT_KEY);
    return true;
  } catch {
    await settings.set(PENDING_DISCLOSURE_CONSENT_KEY, DISCLOSURE_VERSION);
    return false;
  }
}

/** Sends a consent `recordDisclosureConsent` could not; a no-op when none is owed. */
export async function flushPendingDisclosureConsent(
  settings: Pick<SettingsRepo, 'get' | 'remove'>,
  userId: string,
  record: RecordDisclosureConsent = recordConsent
): Promise<void> {
  const version = await settings.get<unknown>(PENDING_DISCLOSURE_CONSENT_KEY);
  if (typeof version !== 'string') return;
  await record(userId, { type: 'background_location', version });
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
}

/**
 * B2's model for the screen and the Home banner. The phone is read on mount and on every return
 * to the front (`AppState → active`) and when the caller asks (`refresh`, after a Fix) — never on
 * a timer, so an armed-idle phone costs nothing (design §3.5).
 *
 * The context is the driver's, never guessed: auto-record from `host.autoDetectEnabled()` (the
 * choice, not the engine's status — N-m2), its availability from the `auto_detect` flag, the first
 * completed drive from the trip list, manual-by-choice and the ever-granted memory from settings.
 * A failed read is `status: 'error'`, not a made-up state.
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

  const [read, setRead] = useState<Read | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const latest = useRef(0);

  /** One read of the phone and the settings it is judged with; null when the phone can't be read. */
  const fetchRead = useCallback(async (): Promise<Read | null> => {
    try {
      const snapshot = await adapter.snapshot();
      const prev = (await settings.get<EverGranted>(EVER_GRANTED_KEY)) ?? {};
      const everGranted = nextEverGranted(prev, snapshot);
      if (everGranted !== prev) await settings.set(EVER_GRANTED_KEY, everGranted);
      const manualByChoice = (await settings.get<boolean>(MANUAL_BY_CHOICE_KEY)) === true;
      return { snapshot, manualByChoice, everGranted };
    } catch {
      return null;
    }
  }, [adapter, settings]);

  /** Reads, and shows the result unless a newer read started meanwhile or the caller unmounted. */
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await fetchRead();
    if (!live.current || ticket !== latest.current) return;
    setRead(result);
    setFailed(result === null);
  }, [fetchRead]);

  useEffect(() => {
    live.current = true;
    const run = () => {
      const ticket = ++latest.current;
      void fetchRead().then((result) => {
        if (!live.current || ticket !== latest.current) return;
        setRead(result);
        setFailed(result === null);
      });
    };
    run();
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') run();
    });
    return () => {
      live.current = false;
      sub.remove();
    };
  }, [fetchRead, appState]);

  // A background-location consent the disclosure could not send (offline) goes when this is read.
  useEffect(() => {
    if (userId !== null) void flushPendingDisclosureConsent(settings, userId).catch(() => {});
  }, [settings, userId, read]);

  const refresh = load;

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
  };
  return {
    status: 'ready',
    snapshot: read.snapshot,
    report: assessHealth(read.snapshot, context),
    context,
    refresh,
  };
}
