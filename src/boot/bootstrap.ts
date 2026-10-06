// The launch (plan §5): open and migrate SQLite, settle whose device this is, recover a drive the
// previous process was recording (continue it if the capture still runs, else finalize it), boot
// the drive host, start the sync runner. Everything platform-shaped is injected, so the whole
// launch runs under Jest against sql.js and the fake drive-sense.
//
// Nothing here starts a drive: a background launch (an iOS relaunch mid-drive, the Android
// headless task) only keeps alive a drive the user already started.
import type { QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { createExpoAlertPorts } from '@/core/alerts/adapters';
import { createAlertPlayer, type AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import type { AdoptedTrip, TripSession } from '@/core/engine/engine.types';
import { finalizeTrip } from '@/core/engine/finalize';
import { recoverRecordingTrips, type RecoveryResult } from '@/core/engine/recovery';
import { createSpeedLimitClient, type SpeedLimitClient } from '@/core/speedLimits/client';
import { createSupabaseSpeedLimitApi, type SpeedLimitApi, type SpeedLimitsSupabase } from '@/core/speedLimits/api';
import { readFlag, refreshAppConfig, type AppConfigSupabase } from '@/data/config/appConfig';
import { createExpoDb, createSettingsRepo, createTripsRepo, migrate, type Db, type TripRow } from '@/data/db';
import { onDataChanged } from '@/data/events';
import { runWhenForeground, type AppStateLike as ForegroundAppState } from '@/data/foreground';
import { restoreDrives } from '@/data/hydrate/restore';
import { getSharedOnline } from '@/data/net/net';
import { createQueryClient } from '@/data/queries/client';
import { subscribeInvalidation } from '@/data/queries/invalidate';
import { invalidateServer, type MySummary } from '@/data/server/summary';
import { serverKey } from '@/data/server/useServerQuery';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { createSyncRunner, type SyncRunner, type SyncSupabase } from '@/data/sync/runner';
import { createDriveDisplay, nativeDisplaySinks, type DriveDisplay } from '@/drive/display';
import { createDriveHost, playerInputs, type DriveHost } from '@/drive/host';
import { nativeDriveSource, type DriveSource } from '@/drive/source';
import { deviceZone } from '@/lib/deviceZone';
import { safeMilesEarlierToday } from '@/core/engine/finalize';
import { dayKey } from '@/lib/time';

import { ensureDeviceOwner, PENDING_OWNER_KEY, readDeviceOwner, type DeviceOwnerOutcome } from './device';
import { drainPolicy, launchProfile, type LaunchProfile } from './launchProfile';

export const DB_NAME = 'roadwise.db';
export const BOOTSTRAP_TIMEOUT_MS = 20_000;
export const SESSION_TIMEOUT_MS = 1_500;
export const ZONE_REREAD_MS = 60_000;
export const APP_CONFIG_INTERVAL_MS = 24 * 60 * 60_000;
/** A capture whose last row is older than this is not continued: the drive is finalized as it stood. */
export const ADOPT_MAX_GAP_MS = 5 * 60_000;

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

export interface BootstrapDeps {
  openDb?: () => Promise<Db>;
  supabase?: BootSupabase;
  newId?: () => string;
  appState?: ForegroundAppState & { currentState?: string | null };
  mayDrain?: () => boolean;
  profile?: LaunchProfile;
  source?: DriveSource;
  limits?: SpeedLimitClient;
  speedLimitsSupabase?: SpeedLimitsSupabase;
  appConfig?: AppConfigSupabase;
  createPlayer?: (inputs: ReturnType<typeof playerInputs>) => Promise<AlertPlayer>;
  display?: DriveDisplay | null;
  /** Just-in-time permissions for Start Drive. Default: `ensureDrivePermissions`. */
  permissions?: () => Promise<{ location: 'granted' | 'denied' }>;
  /** One speed read on the Start tap. Default: `currentSpeedMps` (expo-location). */
  speedProbe?: () => Promise<number | null>;
  voiceEnabled?: () => boolean;
  /** The DMS bridge (WP8): presence and the per-row hook. `null`: none. */
  createCamera?: ((db: Db, host: () => DriveHost | undefined) => CameraLike) | null;
  attachSummaryNotifier?: ((host: DriveHost, db: Db) => { detach(): void; settled?(): Promise<void> }) | null;
  sessionTimeoutMs?: number;
  /** The driver a handover already knows: the identity stage decides on this uid with no session read. */
  expectedUid?: string;
  queryClient?: QueryClient;
  timeoutMs?: number;
  now?: () => number;
  tz?: string;
  appVersion?: string;
  onError?: (error: unknown, context: string) => void;
}

/** What the launch needs of the camera bridge. */
export interface CameraLike {
  presence(): { lastFaceT: number | null } | null;
  onRow(row: import('@/core/engine/types').FeatureRow, motion: import('@/core/engine/motionEvidence').MotionEvidence | null): void;
  attach(host: DriveHost): () => void;
  dispose(): Promise<void>;
  settled?(): Promise<void>;
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
  recovery: RecoveryResult;
  owner: DeviceOwnerOutcome;
  schemaVersion: number;
  now: () => number;
  /** Fetch the public config (feature flags) once; rejects on failure. */
  refreshConfig(): Promise<void>;
  /** Restore the user's drives from the server when the device holds none. */
  restore(): Promise<void>;
  /** Stops the runner, then the drive host (ending an open drive unless told not to), and empties the cache. */
  stop(opts?: { endOpenTrip?: boolean }): Promise<void>;
}

function warn(error: unknown, context: string): void {
  if (__DEV__) console.warn(`[bootstrap] ${context}:`, error);
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

  enter('identity');
  const identity = await stage('identity', async () => {
    const supabase: BootSupabase = deps.supabase ?? ((await import('@/data/supabase/client')).supabase as unknown as BootSupabase);
    const decide = (uid: string | null) => ensureDeviceOwner(db, uid, { onError });
    if (deps.expectedUid !== undefined) return { supabase, owner: await decide(deps.expectedUid) };
    const sessionMs = deps.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
    const reading = supabase.auth.getSession();
    const session = await withinMs(reading, sessionMs);
    let owner: DeviceOwnerOutcome;
    if (session !== TIMED_OUT) {
      owner = await decide(session.data.session?.user.id ?? null);
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

  const newId = deps.newId ?? (await import('@/lib/ids')).newClientTripId;
  const source = deps.source ?? nativeDriveSource;
  const limits = deps.limits ?? defaultLimits(db, deps, now, onError);
  const queryClient = deps.queryClient ?? createQueryClient();

  /** The cached summary (if any screen fetched it) for the local estimate. */
  const summaryContext = async (): Promise<{ streak: number; safeMilesEarlierToday: number } | null> => {
    const owner = await readDeviceOwner(db);
    if (owner === null) return null;
    const cached = queryClient.getQueryData<MySummary>(serverKey(owner, 'summary'));
    const streak = cached?.progress.streak ?? 0;
    const today = dayKey(new Date(now()), currentZone());
    return { streak, safeMilesEarlierToday: await safeMilesEarlierToday(db, today, now()) };
  };
  const finalizeDeps = (session: Readonly<TripSession>) =>
    finalizeTrip(session, { db, tz: currentZone(), now, appVersion, context: async () => (await summaryContext()) ?? null });

  enter('recover');
  const recovery = await stage('recover', () =>
    recoverRecordingTrips(db, {
      createDetectors: () => createDetectors(newId),
      limits: { lookup: (lat, lng, course) => limits.lookupStored(lat, lng, course) },
      now,
      async adoptable(_trip: TripRow, lastRowTs: number | null) {
        try {
          const state = await source.getState();
          return state.capturing && lastRowTs !== null && now() - lastRowTs <= ADOPT_MAX_GAP_MS;
        } catch {
          return false;
        }
      },
      finalize: (session) => finalizeDeps(session).then(() => undefined),
    })
  );
  for (const failure of recovery.failed) onError(failure.error, `recover ${failure.clientTripId}`);

  enter('engine');
  const engine = await stage('engine', async () => {
    let host: DriveHost | undefined;
    let player: AlertPlayer;
    let alertsAvailable = true;
    try {
      player = await (deps.createPlayer ?? defaultPlayer(onError, db))(playerInputs(() => host));
    } catch (error) {
      onError(new Error(`alert sound could not be loaded (${error instanceof Error ? error.name : typeof error})`), 'alert ports');
      alertsAvailable = false;
      player = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
    }
    let camera: CameraLike | null = null;
    try {
      camera = deps.createCamera === undefined ? null : deps.createCamera?.(db, () => host) ?? null;
    } catch (error) {
      onError(error, 'camera');
    }
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
      speedProbe: deps.speedProbe ?? defaultSpeedProbe,
      context: summaryContext,
      voiceEnabled: deps.voiceEnabled ?? defaultVoiceEnabled,
      presence: camera === null ? undefined : () => camera.presence(),
      onRow: camera === null ? undefined : (row, motion) => camera.onRow(row, motion),
      appState,
      alertsAvailable,
      signedOut: identity.owner === 'signed-out',
      onError: (error, context) => onError(error, `drive ${context}`),
    });
    host = drive;
    const detachCamera = camera?.attach(drive) ?? (() => {});
    const adopt: AdoptedTrip | null = recovery.adopt;
    await drive.boot({ adopt });
    if (!drive.isBusy()) limits.resetTrip();

    const attach = deps.attachSummaryNotifier === undefined ? defaultSummaryNotifier : deps.attachSummaryNotifier;
    let notifier: { detach(): void; settled?(): Promise<void> } | null = null;
    if (attach) {
      try {
        notifier = attach(drive, db);
      } catch (error) {
        onError(error, 'summary notifier');
      }
    }
    const release = async (): Promise<void> => {
      detachCamera();
      if (camera !== null) {
        await camera.settled?.();
        await camera.dispose();
      }
      await notifier?.settled?.().catch((error: unknown) => onError(error, 'summary notifier'));
      notifier?.detach();
    };
    return { drive, adopted: adopt?.session.clientTripId ?? null, release };
  });

  const detach = subscribeInvalidation(queryClient);
  // A settled upload or action moved the server's numbers too: the summary header refetches.
  const offServer = onDataChanged((change) => {
    if (change.source === 'sync') void invalidateServer(queryClient);
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

  return {
    db,
    queryClient,
    runner: started,
    drive: engine.drive,
    limits,
    profile,
    adopted: engine.adopted,
    recovery,
    owner: identity.owner,
    schemaVersion,
    now,
    async refreshConfig() {
      const seam = deps.appConfig ?? (await import('@/data/supabase/client')).supabase;
      await refreshAppConfig(seam, db, now);
    },
    async restore() {
      if ((await readDeviceOwner(db)) === null) return;
      await restoreDrives({ db, rpc, now });
    },
    async stop(opts = {}) {
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

/** The speed-limit client over the edge function. The function client is imported on the first request. */
function defaultLimits(db: Db, deps: BootstrapDeps, now: () => number, onError: (error: unknown, context: string) => void): SpeedLimitClient {
  let api: Promise<SpeedLimitApi> | null = null;
  const load = () =>
    (api ??= (async () => createSupabaseSpeedLimitApi(deps.speedLimitsSupabase ?? (await import('@/data/supabase/client')).supabase))());
  return createSpeedLimitClient({
    db,
    api: {
      getTiles: async (keys) => (await load()).getTiles(keys),
      lookupPoint: async (req) => (await load()).lookupPoint(req),
    },
    now,
    online: getSharedOnline,
    onError: (error) => onError(error, 'speed limits'),
  });
}

function defaultPermissions(db: Db): () => Promise<{ location: 'granted' | 'denied' }> {
  return async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the permission adapters
    const { ensureDrivePermissions } = require('@/features/drive/permissions') as typeof import('@/features/drive/permissions');
    const result = await ensureDrivePermissions({ settings: createSettingsRepo(db) });
    return { location: result.location };
  };
}

async function defaultSpeedProbe(): Promise<number | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: expo-location
  const { currentSpeedMps } = require('@/features/drive/movingCheck') as typeof import('@/features/drive/movingCheck');
  return currentSpeedMps();
}

function defaultVoiceEnabled(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the settings cache (WP9)
  const { voicePrefEnabled } = require('@/features/settings/alerts/voicePref') as typeof import('@/features/settings/alerts/voicePref');
  return voicePrefEnabled();
}

function defaultSummaryNotifier(host: DriveHost, db: Db): { detach(): void; settled(): Promise<void> } {
  void db;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const { attachSummaryNotifier } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
  return attachSummaryNotifier(host);
}

/** The alert player over the device ports. A port that will not load rejects; the drive then records without sound. */
function defaultPlayer(onError: (error: unknown, context: string) => void, db: Db): (inputs: ReturnType<typeof playerInputs>) => Promise<AlertPlayer> {
  return async (inputs) => {
    const ports = await createExpoAlertPorts();
    /* eslint-disable @typescript-eslint/no-require-imports -- the settings caches (WP9) */
    const { loadVoicePref, voicePrefEnabled } = require('@/features/settings/alerts/voicePref') as typeof import('@/features/settings/alerts/voicePref');
    const { loadAlertStylePref, alertStylePref } = require('@/features/settings/alerts/stylePref') as typeof import('@/features/settings/alerts/stylePref');
    /* eslint-enable @typescript-eslint/no-require-imports */
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
 * the restore (once per launch while the device holds no drives), the public config (daily) and
 * the expired-tile purge.
 */
export async function startForegroundJobs(runtime: AppRuntime, deps: ForegroundJobsDeps = {}): Promise<ForegroundJobs> {
  const onError = deps.onError ?? warn;
  const foreground = { appState: deps.appState ?? AppState, now: runtime.now, db: runtime.db, onError };
  let restoredThisLaunch = false;
  const restore = async (): Promise<void> => {
    if (restoredThisLaunch) return;
    if ((await createTripsRepo(runtime.db).count()) > 0) {
      restoredThisLaunch = true;
      return;
    }
    await runtime.restore();
    restoredThisLaunch = true;
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
  return {
    async stop() {
      stopRestore();
      stopConfig();
    },
    async runNow() {
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

/** Before the session ends at sign-out: one drain while the session can still send. */
export async function flushBeforeSignOut(runtime: AppRuntime): Promise<{ sent: number; left: number }> {
  const result = await runtime.runner.drainOnce();
  return { sent: result.done, left: await runtime.runner.owed() };
}

export { readFlag };
