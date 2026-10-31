// The launch (plan §5): open and migrate SQLite, settle whose device this is, recover a drive the
// previous process was recording (continue it if the capture still runs or native still journals
// it, else finalize it), boot the drive host (which on iOS also takes in every drive the native
// detector journaled while JS was away), start the sync runner. Everything platform-shaped is
// injected, so the whole launch runs under Jest against sql.js and the fake drive-sense.
//
// Nothing here starts a drive by itself: on iOS the native detector does (the host adopts it), and
// on Android only the Start card does.
import type { QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { createExpoAlertPorts } from '@/core/alerts/adapters';
import { createAlertPlayer, type AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import type { AdoptedTrip, TripSession } from '@/core/engine/engine.types';
import { closeDrive, isDropped } from '@/core/engine/finalize';
import { recoverRecordingTrips, type RecoveryResult } from '@/core/engine/recovery';
import { createSpeedLimitClient, type SpeedLimitClient } from '@/core/speedLimits/client';
import { createSupabaseSpeedLimitApi, type SpeedLimitApi, type SpeedLimitsSupabase } from '@/core/speedLimits/api';
import { refreshAppConfig, type AppConfigSupabase } from '@/data/config/appConfig';
import { createExpoDb, createQueueRepo, createSettingsRepo, migrate, type Db, type TripRow } from '@/data/db';
import { createDefaultAppAttest } from '@/data/devices/appAttest';
import { preloadDeviceSecret } from '@/data/devices/deviceSecret';
import { getInstallId } from '@/data/devices/installId';
import { createPushToStart } from '@/data/devices/liveActivity';
import { onDataChanged } from '@/data/events';
import { runWhenForeground, type AppStateLike as ForegroundAppState } from '@/data/foreground';
import { archiveOldDrives } from '@/data/hydrate/archive';
import { restoreDrives, type RestoreResult } from '@/data/hydrate/restore';
import { createExpoNet, getSharedOnline } from '@/data/net/net';
import { createQueryClient } from '@/data/queries/client';
import { subscribeInvalidation } from '@/data/queries/invalidate';
import { invalidateAfterDrive } from '@/data/server/invalidate';
import type { MySummary } from '@/data/server/summary';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { createSyncRunner, type SyncRunner, type SyncSupabase } from '@/data/sync/runner';
import { dashcamFinalizeDeps } from '@/dashcam/finalizeDeps';
import { setActiveDashcam } from '@/dashcam/registry';
import { createDashcamRuntime, type DashcamRuntime } from '@/dashcam/runtime';
import { createDriveDisplay, nativeDisplaySinks, type DriveDisplay } from '@/drive/display';
import { writeDropNotice } from '@/drive/dropNotice';
import { createDriveHost, finishPendingCancel, isJournaled, playerInputs, type DriveHost, type DriveStartPermissions, type PushToStartOutcome, type PushToStartRequest } from '@/drive/host';
import { bindDriveScreenMemory, DRIVE_SCREEN_ENTERED_KEY, isDriveScreenFocused, markDriveScreenEntered } from '@/features/drive/hudPresence';
import type { StoredDrive } from '@/features/drive/summaryNotifier';
import { alertStylePref, loadAlertStylePref } from '@/features/settings/alerts/stylePref';
import { loadVoicePref, voicePrefEnabled } from '@/features/settings/alerts/voicePref';
import { nativeDashpal, nativeDriveDetect, nativeDriveSource, type DashpalNative, type DriveSource } from '@/drive/source';
import { reportError } from '@/lib/crashReport';
import { deviceZone } from '@/lib/deviceZone';

import type { DriveDetectApi } from '@drive-sense';

import { autoDetectForeground, autoDetectOff, autoDetectSync, setAutoDetectRuntime } from './autoDetect';
import { ensureDeviceOwner, PENDING_OWNER_KEY, readDeviceOwner, type DeviceOwnerOutcome } from './device';
import { drainPolicy, launchProfile, type LaunchProfile } from './launchProfile';

export const DB_NAME = 'roadwise.db';
export const BOOTSTRAP_TIMEOUT_MS = 20_000;
export const SESSION_TIMEOUT_MS = 1_500;
export const ZONE_REREAD_MS = 60_000;
export const APP_CONFIG_INTERVAL_MS = 24 * 60 * 60_000;
/** How often, while the app is in front, drives past the 183 days are archived (`archiveOldDrives`). */
export const ARCHIVE_INTERVAL_MS = 24 * 60 * 60_000;
/** A capture whose last row is older than this is not continued: the drive is finalized as it stood. */
export const ADOPT_MAX_GAP_MS = 5 * 60_000;
/** Set once the forgot-to-start reminder (retired) has been switched off on this install. */
export const REMINDER_RETIRED_KEY = 'reminder.retired';

export type BootstrapStage = 'open' | 'migrate' | 'identity' | 'recover' | 'engine' | 'sync';

export class BootstrapError extends Error {
  readonly stage: BootstrapStage;
  readonly reason: unknown;

  constructor(stage: BootstrapStage, reason: unknown) {
    super(`bootstrap failed at ${stage}: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = 'BootstrapError';
    this.stage = stage;
    this.reason = reason;
  }
}

/** The Supabase client as the launch uses it: the runner's slice plus `rpc`. */
export type BootSupabase = SyncSupabase & { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/** What the DashPal runtime is built from. */
export interface DashcamArgs {
  db: Db;
  player: AlertPlayer;
  host: () => DriveHost | undefined;
  appState: ForegroundAppState;
  now: () => number;
  newId: () => string;
  onError: (error: unknown, context: string) => void;
  /** the alert ports loaded (the player can sound at all; a failed sound is the link's 30 s rule) */
  alertsLoaded: boolean;
  native: DashpalNative;
}

/** The recap notifier as the launch holds it: `announceStored` takes the orphans crash recovery stored. */
export interface LaunchSummaryNotifier {
  detach(): void;
  settled?(): Promise<void>;
  announceStored?(drives: readonly StoredDrive[]): void;
}

export interface BootstrapDeps {
  openDb?: () => Promise<Db>;
  supabase?: BootSupabase;
  newId?: () => string;
  appState?: ForegroundAppState & { currentState?: string | null };
  mayDrain?: () => boolean;
  profile?: LaunchProfile;
  source?: DriveSource;
  /** iOS: the drive detector. Default: the native module (null on Android, in Jest and on web). */
  detect?: DriveDetectApi | null;
  /**
   * iOS: ask the server to push-start a drive's Live Activity, answering whether it was sent and, if
   * not, why and whether a retry soon may send. Default: `createPushToStart` (one retry-safe starter
   * for the launch) with this install's id, over the launch's Supabase client.
   */
  pushToStart?: (req: PushToStartRequest) => Promise<boolean | PushToStartOutcome>;
  limits?: SpeedLimitClient;
  speedLimitsSupabase?: SpeedLimitsSupabase;
  appConfig?: AppConfigSupabase;
  createPlayer?: (inputs: ReturnType<typeof playerInputs>) => Promise<AlertPlayer>;
  display?: DriveDisplay | null;
  /** Just-in-time permissions for Start Drive. Default: `ensureDrivePermissions` (asks for location only). */
  permissions?: () => Promise<DriveStartPermissions>;
  /** The phone's cached position for the speed-limit fetch at Start. Default: expo-location's last known (≤ 10 min old). */
  lastPosition?: () => Promise<{ lat: number; lng: number } | null>;
  voiceEnabled?: () => boolean;
  attachSummaryNotifier?: ((host: DriveHost, db: Db) => LaunchSummaryNotifier) | null;
  /**
   * The DashPal dashcam runtime (plan §7). Default: `createDashcamRuntime` over the process BLE
   * transport, which is only created once a dashcam is paired or setup runs. `null`: none.
   */
  createDashcam?: ((args: DashcamArgs) => DashcamRuntime) | null;
  /** drive-sense's DashPal side (audio probe, wake lock, Android link service). Default: the native module. */
  dashpal?: DashpalNative;
  /** The diagnostics battery recorder, dev builds only. Default: `defaultDiagnostics`. `null`: none. */
  mountDiagnostics?: ((host: DriveHost, db: Db, onError: (error: unknown) => void) => () => void) | null;
  sessionTimeoutMs?: number;
  /**
   * The process's network adapter, which the speed limits and the account screens read
   * (`getSharedOnline`), made at launch and not waited for. Default: `createExpoNet`. `null`: none.
   */
  createNet?: (() => Promise<unknown>) | null;
  /**
   * iOS: keep the database out of iCloud and Finder backups, not waited for. Default: drive-sense's
   * `excludeFromBackup` on expo-sqlite's directory, when the launch opened that database itself
   * (not an injected `openDb`). `null`: none.
   */
  excludeFromBackup?: (() => Promise<void>) | null;
  /** The driver a handover already knows: the identity stage decides on this uid with no session read. */
  expectedUid?: string;
  queryClient?: QueryClient;
  timeoutMs?: number;
  now?: () => number;
  tz?: string;
  appVersion?: string;
  onError?: (error: unknown, context: string) => void;
}

export interface AppRuntime {
  db: Db;
  queryClient: QueryClient;
  runner: SyncRunner;
  drive: DriveHost;
  limits: SpeedLimitClient;
  profile: LaunchProfile;
  /** The interrupted drive the host continued, or null. */
  adopted: string | null;
  /** The DashPal dashcam runtime, or null where none was built. */
  dashcam: DashcamRuntime | null;
  recovery: RecoveryResult;
  owner: DeviceOwnerOutcome;
  schemaVersion: number;
  now: () => number;
  /** Fetch the public config once; rejects on failure. */
  refreshConfig(): Promise<void>;
  /**
   * Restore the owner's drives the device does not hold (`restoreDrives`). Null when the device has
   * no owner yet (nothing to restore for); rejects when the read fails or the run was abandoned.
   */
  restore(): Promise<RestoreResult | null>;
  /** Stops the runner, then the drive host (ending an open drive unless told not to), and empties the cache. */
  stop(opts?: { endOpenTrip?: boolean }): Promise<void>;
}

/** The default error hook: the dev console, and the crash sink (release builds only, rate-limited). */
function warn(error: unknown, context: string): void {
  if (__DEV__) console.warn(`[bootstrap] ${context}:`, error);
  reportError(error, `bootstrap: ${context}`);
}

/** The whole launch, with a deadline around it: a hang is reported as a failure at the stage reached. */
export async function bootstrapApp(deps: BootstrapDeps = {}): Promise<AppRuntime> {
  const limitMs = deps.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  let reached: BootstrapStage = 'open';
  let abandoned = false;

  const sequence = runLaunch(deps, (name) => {
    reached = name;
  });
  sequence.then(
    (runtime) => {
      if (abandoned) void runtime.stop({ endOpenTrip: false });
    },
    () => {}
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(new BootstrapError(reached, new Error(`timed out after ${limitMs} ms`)));
    }, limitMs);
  });
  try {
    return await Promise.race([sequence, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function stage<T>(name: BootstrapStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (reason) {
    throw new BootstrapError(name, reason);
  }
}

const TIMED_OUT = Symbol('timed out');

async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A session read that answered nothing but an error: auth-js hands back no session with the refresh's
 * error when the stored access token has expired and could not be refreshed (no network). Signed
 * out reads answer no session and no error.
 */
function sessionUnknown(read: { data: { session: unknown }; error?: unknown }): boolean {
  return read.data.session === null && read.error !== null && read.error !== undefined;
}

async function ownerMayHaveChanged(db: Db): Promise<boolean> {
  const settings = createSettingsRepo(db);
  const owner = await readDeviceOwner(db);
  const seen = await settings.get<string>(SESSION_UID_KEY);
  const pending = await settings.get<string>(PENDING_OWNER_KEY);
  return (seen !== null && seen !== owner) || (pending !== null && pending !== owner);
}

async function runLaunch(deps: BootstrapDeps, enter: (name: BootstrapStage) => void): Promise<AppRuntime> {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? warn;
  const appState = deps.appState ?? AppState;
  const profile = deps.profile ?? launchProfile(appState);
  let zone = deps.tz ?? deviceZone();
  let zoneReadAt = now();
  const currentZone = (): string => {
    if (deps.tz !== undefined) return deps.tz;
    const at = now();
    if (at - zoneReadAt >= ZONE_REREAD_MS || at < zoneReadAt) {
      zone = deviceZone();
      zoneReadAt = at;
    }
    return zone;
  };
  const appVersion = deps.appVersion ?? readAppVersion();

  enter('open');
  const db = await stage('open', () => (deps.openDb ?? (() => createExpoDb(DB_NAME)))());
  enter('migrate');
  const schemaVersion = await stage('migrate', () => migrate(db));
  // Drives past the 183 days leave the lists before anything reads them: local SQL only, and it
  // does nothing while a drive is recording. A failure holds nothing up (the daily job retries).
  await archiveOldDrives(db, now()).catch((error: unknown) => onError(error, 'archive old drives'));
  // Neither holds the launch, and a failure costs only what it would have given.
  const createNet = deps.createNet === undefined ? createExpoNet : deps.createNet;
  if (createNet) void createNet().catch((error: unknown) => onError(error, 'network state'));
  const exclude = deps.excludeFromBackup === undefined ? (deps.openDb ? null : excludeDatabaseFromBackup) : deps.excludeFromBackup;
  if (exclude) void exclude().catch((error: unknown) => onError(error, 'backup exclusion'));
  // The privacy-trim secret into memory while the phone is in hand: a locked-phone auto-end or a
  // background recovery finalizes from the cache (expo-secure-store, AFTER_FIRST_UNLOCK).
  void preloadDeviceSecret(undefined, (error) => onError(error, 'device secret'));

  // iPhone's drive detector: the identity stage's wipe (an account switch) clears its state too.
  const detect = deps.detect === undefined ? nativeDriveDetect() : deps.detect;

  enter('identity');
  const identity = await stage('identity', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only outside tests
    const supabase: BootSupabase = deps.supabase ?? ((require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase as unknown as BootSupabase);
    const decide = (uid: string | null) => ensureDeviceOwner(db, uid, { onError, detect });
    if (deps.expectedUid !== undefined) return { supabase, owner: await decide(deps.expectedUid) };
    const sessionMs = deps.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
    const reading = supabase.auth.getSession();
    const session = await withinMs(reading, sessionMs);
    let owner: DeviceOwnerOutcome;
    if (session !== TIMED_OUT && !sessionUnknown(session)) {
      owner = await decide(session.data.session?.user.id ?? null);
    } else if (session !== TIMED_OUT) {
      // No session, with an error: an expired token that could not refresh (offline). The stored
      // session may well still be good: the owner stands, as when the read is slow. A session that
      // really ended reaches the app as SIGNED_OUT.
      owner = (await readDeviceOwner(db)) === null ? 'signed-out' : 'same';
      onError(new Error('the session could not be read'), 'identity: session');
    } else if (await ownerMayHaveChanged(db)) {
      onError(new Error(`getSession did not answer within ${sessionMs} ms`), 'identity: session');
      owner = await decide((await reading).data.session?.user.id ?? null);
    } else {
      owner = (await readDeviceOwner(db)) === null ? 'signed-out' : 'same';
      onError(new Error(`getSession did not answer within ${sessionMs} ms`), 'identity: session');
    }
    return { supabase, owner };
  });
  const rpc = async (fn: string, args?: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await identity.supabase.rpc(fn, args ?? {});
    if (error) throw error instanceof Error ? error : new Error(`${fn} failed`);
    return data;
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- expo-crypto, only outside tests
  const newId = deps.newId ?? (require('@/lib/ids') as typeof import('@/lib/ids')).newClientTripId;
  const source = deps.source ?? nativeDriveSource;
  const limits = deps.limits ?? defaultLimits(db, deps, now, onError);
  const queryClient = deps.queryClient ?? createQueryClient();

  // The forgot-to-start reminder is retired: one switch-off per install stops one left on from
  // before (the Android module still has it; iOS answers off).
  await retireReminder(db, source, onError);

  // Automatic drives (iPhone) follow the signed-in, onboarded driver (`autoDetect.ts`).
  setAutoDetectRuntime({
    db,
    detect,
    // Rejects when the session cannot be read (unknown): automatic drives then stay as they are.
    uid: async () => {
      const read = await identity.supabase.auth.getSession();
      if (sessionUnknown(read)) throw new Error('the session could not be read');
      return read.data.session?.user.id ?? null;
    },
    // `serverKey(owner, 'summary')` from src/data/server/useServerQuery.ts, spelled out so a
    // background launch never loads the Supabase client through that module.
    onboarded: (uid) => Boolean(queryClient.getQueryData<MySummary>(['server', uid, 'summary'])?.profile.onboarded_at),
    onError,
  });

  // Crash recovery finalizes with the drive's stored DashPal facts too (plan §7.7). An orphan that
  // never moved is dropped, and Home says why (no OS notification). One kept is handed to the recap
  // notifier once it is attached (it decides whether it is recent enough to post).
  const storedOrphans: StoredDrive[] = [];
  const finalizeDeps = async (session: Readonly<TripSession>): Promise<'finalized' | 'dropped'> => {
    const result = await closeDrive(session, {
      db,
      tz: currentZone(),
      now,
      appVersion,
      ...dashcamFinalizeDeps(db),
    });
    if (!isDropped(result)) {
      storedOrphans.push({
        clientTripId: result.trip.client_trip_id,
        ok: true,
        status: result.trip.status,
        dropped: null,
        endCause: 'orphan',
        at: now(),
        durationS: result.trip.duration_s,
        miles: result.trip.miles,
        endedAt: result.trip.ended_at ?? session.endedAt ?? null,
      });
      return 'finalized';
    }
    await writeDropNotice(db, { clientTripId: result.clientTripId, cause: 'orphan', reason: result.dropped, at: now(), origin: session.origin }).catch((e: unknown) => onError(e, 'dropNotice'));
    return 'dropped';
  };

  // A "Not driving?" the last process was killed in the middle of is finished first, so the
  // cancelled drive is never recovered or recorded again.
  await finishPendingCancel(db, detect, onError).catch((error: unknown) => onError(error, 'not driving'));

  enter('recover');
  const recovery = await stage('recover', () =>
    recoverRecordingTrips(db, {
      createDetectors: () => createDetectors(newId),
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      limits: { lookup: (lat, lng, course) => limits.lookupStored(lat, lng, course) },
      now,
      async adoptable(trip: TripRow, lastRowTs: number | null) {
        // iOS: native still journals the drive (live, or ended while JS was away): the host takes the rest in.
        if (detect !== null && (await isJournaled(db, detect, trip.client_trip_id))) return true;
        try {
          const state = await source.getState();
          return state.capturing && lastRowTs !== null && now() - lastRowTs <= ADOPT_MAX_GAP_MS;
        } catch {
          return false;
        }
      },
      finalize: finalizeDeps,
    })
  );
  for (const failure of recovery.failed) onError(failure.error, `recover ${failure.clientTripId}`);

  enter('engine');
  const engine = await stage('engine', async () => {
    let host: DriveHost | undefined;
    let dashcam: DashcamRuntime | null = null;
    let player: AlertPlayer;
    let alertsAvailable = true;
    const inputs = playerInputs(() => host);
    // A sound failing during a DashPal item also tells the dashcam (ALERT_ACK(0): its buzzer).
    const onUnavailable = inputs.onUnavailable;
    inputs.onUnavailable = () => {
      onUnavailable();
      dashcam?.playerUnavailable();
    };
    try {
      player = await (deps.createPlayer ?? defaultPlayer(onError, db, appState))(inputs);
    } catch (error) {
      onError(new Error(`alert sound could not be loaded (${error instanceof Error ? error.name : typeof error})`), 'alert ports');
      alertsAvailable = false;
      player = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
    }
    const makeDashcam = deps.createDashcam === undefined ? defaultDashcam : deps.createDashcam;
    if (makeDashcam) {
      try {
        dashcam = makeDashcam({
          db,
          player,
          host: () => host,
          appState,
          now,
          newId,
          onError: (error, context) => onError(error, `dashcam ${context}`),
          alertsLoaded: alertsAvailable,
          native: deps.dashpal ?? nativeDashpal,
        });
      } catch (error) {
        onError(error, 'dashcam');
      }
    }
    const dc = dashcam;
    const display = deps.display === undefined ? createDriveDisplay(nativeDisplaySinks(), { now, platform: Platform.OS, onError: (e) => onError(e, 'display') }) : deps.display;
    const drive = createDriveHost({
      db,
      source,
      limits,
      player,
      display: display ?? undefined,
      now,
      tz: currentZone,
      newId,
      appVersion,
      permissions: deps.permissions ?? defaultPermissions(db),
      lastPosition: deps.lastPosition ?? defaultLastPosition,
      detect,
      pushToStart:
        deps.pushToStart ??
        createPushToStart({
          deviceId: () => getInstallId(createSettingsRepo(db)),
          invoke: (name, options) => identity.supabase.functions.invoke(name, options),
          onError,
        }),
      voiceEnabled: deps.voiceEnabled ?? defaultVoiceEnabled,
      appState,
      alertsAvailable,
      signedOut: identity.owner === 'signed-out',
      dashcam: dc
        ? {
            row: (row, drive) => dc.row(row, drive),
            adopt: (id) => dc.adopt(id),
            beforeFinalize: (id, o) => dc.beforeFinalize(id, o),
            continuousAlertActive: () => dc.continuousAlertActive(),
          }
        : undefined,
      onError: (error, context) => onError(error, `drive ${context}`),
    });
    host = drive;
    setActiveDashcam(dc);
    // Before the boot: a drive the boot stores (native ended it while no process ran) gets its
    // recap notification; the notifier decides which are recent enough to post.
    const attach = deps.attachSummaryNotifier === undefined ? defaultSummaryNotifier : deps.attachSummaryNotifier;
    let notifier: LaunchSummaryNotifier | null = null;
    if (attach) {
      try {
        notifier = attach(drive, db);
      } catch (error) {
        onError(error, 'summary notifier');
      }
    }
    // The drive the driving screen is first shown for is written down, so a relaunch in the middle
    // of it keeps it entered (the lockout, and an automatic drive's way back to its screen).
    const screenMemory = createSettingsRepo(db);
    const unbindScreenMemory = bindDriveScreenMemory((tripId) => {
      void screenMemory.set(DRIVE_SCREEN_ENTERED_KEY, tripId).catch((error: unknown) => onError(error, 'drive screen'));
    });
    const adopt: AdoptedTrip | null = recovery.adopt;
    try {
      await drive.boot({ adopt });
    } catch (error) {
      // The launch fails with this host: nothing it would announce may post.
      notifier?.detach();
      unbindScreenMemory();
      throw error;
    }
    // A drive taken in at this launch that the driving screen was shown for before it: still entered.
    const taken = drive.snapshot();
    if (taken.status === 'recording' && taken.clientTripId !== null) {
      const enteredFor = await screenMemory.get<unknown>(DRIVE_SCREEN_ENTERED_KEY).catch((error: unknown) => {
        onError(error, 'drive screen');
        return null;
      });
      if (enteredFor === taken.clientTripId) markDriveScreenEntered(taken.clientTripId);
    }
    // The orphans crash recovery stored before the host existed, once the boot shows whether a
    // drive records now (their recaps then wait until none does).
    if (storedOrphans.length > 0) {
      try {
        notifier?.announceStored?.(storedOrphans);
      } catch (error) {
        onError(error, 'summary notifier');
      }
    }
    if (!drive.isBusy()) limits.resetTrip();
    let unmountDiagnostics: () => void = () => {};
    const mount = deps.mountDiagnostics === undefined ? defaultDiagnostics : deps.mountDiagnostics;
    if (mount) {
      try {
        unmountDiagnostics = mount(drive, db, (error) => onError(error, 'diagnostics battery'));
      } catch (error) {
        onError(error, 'diagnostics battery');
      }
    }
    const release = async (): Promise<void> => {
      unmountDiagnostics();
      unbindScreenMemory();
      await notifier?.settled?.().catch((error: unknown) => onError(error, 'summary notifier'));
      notifier?.detach();
      if (dc) {
        // The pending link work (a write, an ACK) is let go: the transport outlives this runtime.
        await dc.link.settled().catch((error: unknown) => onError(error, 'dashcam'));
        dc.dispose();
        setActiveDashcam(null);
      }
    };
    return { drive, adopted: adopt?.session.clientTripId ?? null, release, dashcam: dc };
  });

  const detach = subscribeInvalidation(queryClient);
  // A settled upload or action moved the server's numbers too: the summary header refetches and
  // the boards are marked stale (they refetch when their screen next gains focus).
  const offServer = onDataChanged((change) => {
    if (change.source === 'sync') void invalidateAfterDrive(queryClient);
  });
  const isBusy = () => engine.drive.isBusy();

  enter('sync');
  let runner: SyncRunner | null = null;
  try {
    runner = await stage('sync', async () => {
      const created = createSyncRunner({
        db,
        supabase: identity.supabase,
        mayDrain: deps.mayDrain ?? drainPolicy({ appState }),
        isRecording: isBusy,
        appState,
        // iPhone drive uploads carry App Attest over their exact bytes (src/data/devices/appAttest.ts)
        attest: createDefaultAppAttest((name, options) => identity.supabase.functions.invoke(name, options), onError),
        now,
        onError,
      });
      await created.start();
      return created;
    });
  } catch (reason) {
    void engine.release();
    void engine.drive.stop({ endOpenTrip: false });
    detach();
    offServer();
    throw reason;
  }
  const started = runner;
  let stopped = false;

  return {
    db,
    queryClient,
    runner: started,
    drive: engine.drive,
    limits,
    profile,
    adopted: engine.adopted,
    dashcam: engine.dashcam,
    recovery,
    owner: identity.owner,
    schemaVersion,
    now,
    async refreshConfig() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only outside tests
      const seam = deps.appConfig ?? (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase;
      await refreshAppConfig(seam, db, now);
    },
    async restore() {
      const uid = await readDeviceOwner(db);
      if (uid === null) return null;
      // Wanted only while this runtime lives and the session is still the owner's: a restore that
      // outlives a sign-out or a handover writes nothing more (`restoreDrives` also fences on the owner).
      const isCurrent = async (): Promise<boolean> => {
        if (stopped) return false;
        try {
          const { data } = await identity.supabase.auth.getSession();
          return data.session?.user.id === uid;
        } catch {
          return false;
        }
      };
      return restoreDrives({ db, rpc, now, uid, isCurrent });
    },
    async stop(opts = {}) {
      stopped = true;
      await started.stop();
      await engine.drive.stop({ endOpenTrip: opts.endOpenTrip ?? true });
      await engine.release();
      detach();
      offServer();
      queryClient.clear();
    },
  };
}

function readAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use
    const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
    return Constants.expoConfig?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * iOS: the database directory (the driver's drive history, problem spots, zones and, during a drive,
 * its per-second rows) is kept out of iCloud and Finder backups, as the drive's own file is.
 */
async function excludeDatabaseFromBackup(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const directory = (await import('expo-sqlite')).defaultDatabaseDirectory as string;
  await (await import('@drive-sense')).default.excludeFromBackup(directory);
}

/** The forgot-to-start reminder's one switch-off per install (it is retired). Never fails the launch. */
async function retireReminder(db: Db, source: DriveSource, onError: (error: unknown, context: string) => void): Promise<void> {
  try {
    const settings = createSettingsRepo(db);
    if ((await settings.get<number>(REMINDER_RETIRED_KEY)) === 1 || !source.setTripReminder) return;
    await source.setTripReminder(false);
    await settings.set(REMINDER_RETIRED_KEY, 1);
  } catch (error) {
    onError(error, 'reminder retirement');
  }
}

/** The speed-limit client over the edge function. The function client is imported on the first request. */
function defaultLimits(db: Db, deps: BootstrapDeps, now: () => number, onError: (error: unknown, context: string) => void): SpeedLimitClient {
  let api: Promise<SpeedLimitApi> | null = null;
  const load = () =>
    (api ??= Promise.resolve(
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only outside tests
      createSupabaseSpeedLimitApi(deps.speedLimitsSupabase ?? (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase)
    ));
  return createSpeedLimitClient({
    db,
    api: {
      getTiles: async (keys, opts) => (await load()).getTiles(keys, opts),
      lookupPoint: async (req) => (await load()).lookupPoint(req),
    },
    now,
    online: getSharedOnline,
    onError: (error) => onError(error, 'speed limits'),
  });
}

function defaultPermissions(db: Db): () => Promise<DriveStartPermissions> {
  return async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the permission adapters
    const { ensureDrivePermissions } = require('@/features/drive/permissions') as typeof import('@/features/drive/permissions');
    // The tap asks only for location (needed to record at all), never for motion.
    const result = await ensureDrivePermissions({ settings: createSettingsRepo(db) }, { askMotion: false });
    return { location: result.location, precise: result.precise, services: result.services };
  };
}

/** A cached fix older than this says too little about where the car is. */
const LAST_POSITION_MAX_AGE_MS = 10 * 60_000;

/** expo-location's last known position (the OS's cached fix, no GPS of its own), loaded on first use; null on any failure. */
async function defaultLastPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const pos = await Location.getLastKnownPositionAsync({ maxAge: LAST_POSITION_MAX_AGE_MS });
    return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
  } catch {
    return null;
  }
}

function defaultVoiceEnabled(): boolean {
  return voicePrefEnabled();
}

/** The diagnostics battery recorder, only in a diagnostics build (`diagnosticsEnabled()`), loaded only then. */
function defaultDiagnostics(host: DriveHost, db: Db, onError: (error: unknown) => void): () => void {
  /* eslint-disable @typescript-eslint/no-require-imports -- deferred: the dev screens' modules */
  const { diagnosticsEnabled } = require('@/features/dev/flags') as typeof import('@/features/dev/flags');
  if (!diagnosticsEnabled()) return () => {};
  const { createDriveBatteryRecorder } = require('@/features/dev/battery') as typeof import('@/features/dev/battery');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return createDriveBatteryRecorder({ host, settings: createSettingsRepo(db), onError });
}

function defaultSummaryNotifier(host: DriveHost, db: Db): LaunchSummaryNotifier {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const { attachSummaryNotifier, summaryUnits } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred with the notifier
  const { recapCategory } = require('@/features/notifications/passenger') as typeof import('@/features/notifications/passenger');
  // The driving screen in focus shows a drive's end itself (it opens the recap): no notification then.
  return attachSummaryNotifier(host, { units: summaryUnits(db), isSummaryVisible: isDriveScreenFocused, category: recapCategory(db) });
}

/**
 * The DashPal runtime over the process transport (created only when a dashcam is paired or setup
 * runs, so nothing touches Bluetooth for a driver without one). The phone plays DashPal alerts with
 * or without a drive open, and its player counts as available whenever the alert ports loaded: a
 * sound that failed holds the link's 30 s "cannot play" and no longer. (The host's
 * `alertsAvailable` stays set for the rest of a drive until a sound plays, and a DashPal alert
 * refused for it could never clear it.) On Android the runtime also drives the DashPal link service
 * and the alert wake lock; iOS has neither (an ALERT wakes the app through bluetooth-central).
 */
export function defaultDashcam(args: DashcamArgs): DashcamRuntime {
  const native = args.native;
  const android = Platform.OS === 'android';
  return createDashcamRuntime({
    db: args.db,
    player: args.player,
    transport: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the BLE native module
      const { getDashcamTransport } = require('@/dashcam/transport') as typeof import('@/dashcam/transport');
      return getDashcamTransport();
    },
    host: () => {
      const s = args.host()?.snapshot();
      // Open from the Start Drive tap until finalize has finished (the drive-end catch-up included).
      const driveOpen = s !== undefined && s.status !== 'idle' && !s.dryRun;
      return {
        recording: s?.status === 'recording',
        driveOpen,
        playerAvailable: args.alertsLoaded,
        callActive: s?.callActive ?? false,
      };
    },
    audioOutput: () => native.audioOutputState(),
    ...(android
      ? {
          holdAwake: (ms: number) => {
            native.holdAwake(ms);
          },
          linkService: {
            set: (state) => native.setDashpalLink(state),
            running: () => native.dashpalLinkRunning(),
            onTick: (fn) => native.addListener('dashpalLinkTick', () => fn()),
          },
        }
      : {}),
    styleAllowsSound: () => alertStylePref() !== 'vibration',
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    appState: args.appState,
    now: args.now,
    newId: args.newId,
    onError: args.onError,
  });
}

/**
 * The alert player over the device ports. A port that will not load rejects; the drive then records
 * without sound. Android pauses JS timers while the app is not active: the haptic port then does not
 * wait its pattern out (`src/lib/timers.ts` covers every other wait).
 */
function defaultPlayer(
  onError: (error: unknown, context: string) => void,
  db: Db,
  appState: { currentState?: string | null }
): (inputs: ReturnType<typeof playerInputs>) => Promise<AlertPlayer> {
  return async (inputs) => {
    const ports = await createExpoAlertPorts({
      timersPaused: () => Platform.OS === 'android' && appState.currentState !== 'active',
    });
    const settings = createSettingsRepo(db);
    await Promise.all([loadVoicePref(settings), loadAlertStylePref(settings)]);
    return createAlertPlayer({
      ...ports,
      voiceEnabled: voicePrefEnabled,
      alertStyle: alertStylePref,
      ...inputs,
      onError: (error) => onError(error, 'alert player'),
    });
  };
}

export interface ForegroundJobsDeps {
  appState?: ForegroundAppState;
  onError?: (error: unknown, context: string) => void;
}

export interface ForegroundJobs {
  stop(): Promise<void>;
  /** Run the restore now; resolves true when it completed. */
  runNow(): Promise<boolean>;
}

/**
 * The work that runs only while the driver has the app open, each on a transition to `active`:
 * the restore (once per launch until the owner's has run to the end), the public config (daily), the
 * expired-tile purge and the 7-day prune of DashPal events outside any drive (daily), the archive
 * of drives past 183 days (daily), automatic drives armed or disarmed (every time: iPhone), and the
 * problem spots' recompute.
 */
export async function startForegroundJobs(runtime: AppRuntime, deps: ForegroundJobsDeps = {}): Promise<ForegroundJobs> {
  const onError = deps.onError ?? warn;
  const foreground = { appState: deps.appState ?? AppState, now: runtime.now, db: runtime.db, onError };
  let restoredThisLaunch = false;
  const restore = async (): Promise<void> => {
    if (restoredThisLaunch) return;
    // No owner yet (a launch signed out on a phone nobody has used): nothing is marked done and no
    // stamp is written, so the sign-in that names the owner (`runNow`) or the next foreground restores.
    const result = await runtime.restore();
    if (result === null) throw new Error('no device owner yet: nothing to restore');
    // A run that read its most pages and has more to go carries on at the next return to the front.
    restoredThisLaunch = result.complete;
    await runtime.limits.purgeExpired().catch((error: unknown) => onError(error, 'purge expired tiles'));
  };
  const stopRestore = runWhenForeground('restore', 60_000, restore, foreground);
  const stopConfig = runWhenForeground(
    'config',
    APP_CONFIG_INTERVAL_MS,
    async () => {
      if (runtime.drive.isBusy()) throw new Error('a drive is under way');
      await runtime.refreshConfig();
    },
    foreground
  );
  // DashPal events no drive claimed are kept a week, then pruned (plan §7.5).
  const stopPrune = runWhenForeground(
    'dashcam.prune',
    APP_CONFIG_INTERVAL_MS,
    async () => {
      await runtime.dashcam?.pruneUnattached();
    },
    foreground
  );
  // Drives past the 183 days are archived once a day as well, for an app that stays alive for days.
  const stopArchive = runWhenForeground(
    'archive',
    ARCHIVE_INTERVAL_MS,
    async () => {
      if ((await archiveOldDrives(runtime.db, runtime.now())) === null) throw new Error('a drive is recording');
    },
    foreground
  );
  // Automatic drives (iPhone): armed for the signed-in, onboarded driver on every return to the
  // front while the Automatic drives switch is on (else disarmed), then the app wake.
  const stopAutoDetect = runWhenForeground(
    'autoDetect',
    0,
    async () => {
      await autoDetectForeground();
    },
    foreground
  );
  const spots = startSpots(runtime, foreground.appState, onError);
  return {
    async stop() {
      stopRestore();
      stopConfig();
      stopPrune();
      stopArchive();
      stopAutoDetect();
      spots?.stop();
    },
    async runNow() {
      // A sign-in names the driver: automatic drives follow at once.
      void autoDetectSync();
      try {
        restoredThisLaunch = false;
        await restore();
        return true;
      } catch (error) {
        onError(error, 'restore (run now)');
        return false;
      }
    },
  };
}

/** The problem spots' recompute (`src/features/spots/recompute.ts`), loaded on first use; null when it cannot start. */
function startSpots(runtime: AppRuntime, appState: ForegroundAppState, onError: (error: unknown, context: string) => void): { stop(): void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the spots feature's module
    const { startSpotJobs } = require('@/features/spots/recompute') as typeof import('@/features/spots/recompute');
    return startSpotJobs({ db: runtime.db, appState, isBusy: () => runtime.drive.isBusy(), now: runtime.now, onError: (error, context) => onError(error, `spots ${context}`) });
  } catch (error) {
    onError(error, 'spots');
    return null;
  }
}

/**
 * Every end of a session, whoever ended it (the driver's sign-out, forced or with uploads still
 * owed, a revoked or expired session): automatic drives are disarmed first, so no drive starts
 * with nobody signed in, then an open drive is finalized under the owner. Never rejects.
 */
export async function endSession(runtime: Pick<AppRuntime, 'drive'>): Promise<void> {
  await autoDetectOff();
  await runtime.drive.sessionEnded().catch(() => {});
}

/** Before the session ends at sign-out: one drain while the session can still send (waiting uploads too). */
export async function flushBeforeSignOut(runtime: AppRuntime): Promise<{ sent: number; left: number }> {
  // Everything still owed goes now, while it still can: an upload not yet tried, one in a retry
  // back-off, and one that ran out of retries on server answers without being refused.
  await createQueueRepo(runtime.db).makeOwedDue(runtime.now());
  // A pass already under way may have looked for due items before they were made due: a fresh one does.
  await runtime.runner.idle();
  const result = await runtime.runner.drainOnce();
  return { sent: result.done, left: await runtime.runner.owed() };
}
