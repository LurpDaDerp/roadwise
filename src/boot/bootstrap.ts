/**
 * What has to be true before the first screen reads anything (M2 ruling; M3 adds the engine).
 *
 * In order, because each step needs the one before:
 *   1. open SQLite — WAL, foreign keys, the busy timeout (`createExpoDb`) — and exclude its
 *      directory from iOS backups (plan R4, D2; not awaited, and a failure is only reported);
 *   2. `migrate` to the current schema;
 *   3. whose device this is — a sign-in by a different user empties it, rows and traces alike,
 *      before any of the last owner's data can be read, recovered or uploaded (`./device.ts`);
 *      The session read is bounded (`SESSION_TIMEOUT_MS`): a background launch with no network
 *      must not wait on a token refresh before the engine starts (plan rev1: I3). On a timeout the
 *      persisted owner stands (`same`) — never a wipe on a guess;
 *   4. `recoverRecordingTrips` — a drive the last process died in is finalized from its last
 *      checkpoint, before any engine exists to own a `recording` row. A drive that looks to be
 *      still going on (`adoptable`: checkpointed inside the gap window while capture is running,
 *      was open, or the motion history since says automotive) is **skipped**, left for step 5
 *      (rev1: I2). Recovery reads the tiles already stored on the device (`lookupStored`), the
 *      same source an adopted drive's rebuild uses — never the network; a road with no stored
 *      tile is judged against an unknown limit: no speeding there, everything else;
 *   5. `engine` — the drive host (H1) is built and started. It adopts the newest skipped drive
 *      *before* it subscribes to native events or arms, so a buffered wake cannot open a second
 *      trip for the same drive; anything skipped that it did not adopt is recovered at once (E1
 *      adopt protocol). Nothing here awaits the network;
 *   6. the query client, wired to the one change event so a sync pass, a restore or a finalize
 *      refreshes what is on screen;
 *   7. the sync runner, started. It stays off the database while a drive is recording or
 *      finalizing (`isRecording: drive.isBusy`), and drains only in the foreground or from the
 *      Android headless task (`drainPolicy`, §3.5);
 *   8. the hydrator, built but **not** started: restoring history from the server is network
 *      work, and a background launch (an iOS location wake, the Android headless task) must not
 *      do it (R13). The controller calls `startForegroundJobs(runtime)` once the app is active,
 *      which runs it only while it stays active and at most every `HYDRATE_INTERVAL_MS`.
 *
 * Everything platform-shaped is injectable, so the whole sequence runs under Jest against
 * sql.js; the defaults are the device adapters, imported lazily where they carry a native module.
 */
import * as scoring from '@scoring';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

import type { DriveSenseEvent, DriveSenseEvents, DriveSenseState, Subscription } from '@drive-sense';

import { createExpoAlertPorts } from '@/core/alerts/adapters';
import { createAlertPlayer, type AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import {
  recoverRecordingTrips,
  type RecoveryDeps,
  type RecoveryResult,
} from '@/core/engine/recovery';
import {
  createSupabaseSpeedLimitApi,
  type SpeedLimitApi,
  type SpeedLimitsSupabase,
} from '@/core/speedLimits/api';
import { createSpeedLimitClient, type SpeedLimitClient } from '@/core/speedLimits/client';
import { readFlag, refreshAppConfig, type AppConfigSupabase } from '@/data/config/appConfig';
import { createExpoDb, createTripsRepo, migrate, type Db, type TripRow } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { createExpoNet, getSharedOnline } from '@/data/net/net';
import { createDriveHost, playerInputs, type DriveHost } from '@/drive/host';
import { nativeDriveSource, type DriveSource } from '@/drive/source';
import type { Database } from '@/data/supabase/types';
import {
  foregroundStampKey,
  runWhenForeground,
  type AppStateLike as ForegroundAppState,
} from '@/data/foreground';
import {
  createHydrator,
  HYDRATE_INTERVAL_MS,
  HYDRATE_RESTORED_AT_KEY,
  hydrateSeam,
  type Hydrator,
  type HydrateSupabase,
} from '@/data/hydrate/hydrate';
import { getHydrationStatus, setHydrationStatus } from '@/data/hydrate/status';
import { createQueryClient, subscribeInvalidation } from '@/data/queries';
import {
  createSyncRunner,
  type AppStateLike,
  type FlushResult,
  type NetStatus,
  type NetSubscribable,
  type SyncRunner,
  type SyncSupabase,
  type TraceFs,
} from '@/data/sync/runner';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { createExpoTraceFs } from '@/data/sync/traceFs';

import {
  ensureDeviceOwner,
  PENDING_OWNER_KEY,
  readDeviceOwner,
  type DeviceOwnerOutcome,
} from './device';
import { drainPolicy, launchProfile, type LaunchProfile } from './launchProfile';
import { createExpoTraceWriter, type TraceWriter } from './traceWriter';

/** The one database file on the device. */
export const DB_NAME = 'roadwise.db';

/**
 * How long the whole launch may take before the driver is told it failed. Generous: a first
 * migration on a slow device is seconds, not milliseconds, and a false alarm costs a retry.
 */
export const BOOTSTRAP_TIMEOUT_MS = 20_000;

/**
 * How long the identity stage waits for `getSession()` (plan H2). It can hang on a token refresh
 * with no network; past this the persisted owner stands, so the engine starts within seconds of a
 * background wake rather than when the radio comes back.
 */
export const SESSION_TIMEOUT_MS = 1_500;

/** How often the public config (feature flags) is fetched, in the foreground only (plan D2). */
export const APP_CONFIG_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The `auto_detect` flag's answer before any config was ever fetched: available. The flag only
 * makes the feature available; the driver's own opt-in (default off) is what arms it.
 */
const AUTO_DETECT_FLAG_FALLBACK = true;

export type BootstrapStage = 'open' | 'migrate' | 'identity' | 'recover' | 'engine' | 'sync';

/** Which step failed, with the underlying error kept for the log. */
export class BootstrapError extends Error {
  readonly stage: BootstrapStage;
  readonly reason: unknown;

  constructor(stage: BootstrapStage, reason: unknown) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    super(`bootstrap failed at ${stage}: ${detail}`);
    this.name = 'BootstrapError';
    this.stage = stage;
    this.reason = reason;
  }
}

export interface BootstrapDeps {
  /** Opens the database. Default: `createExpoDb(DB_NAME)`. */
  openDb?: () => Promise<Db>;
  /** Default: the app's Supabase client. The runner and the hydrator each use their own slice. */
  supabase?: SyncSupabase & HydrateSupabase;
  /** The traces directory as the runner reads it. Default: `createExpoTraceFs()`. */
  traceFs?: TraceFs;
  /** The traces directory as the finalizer writes it. Default: `createExpoTraceWriter()`. */
  traceWriter?: TraceWriter;
  /** Default: `sha256Hex` over expo-crypto. */
  hash?: { sha256(text: string): Promise<string> };
  /** Event ids for recovered drives. Default: a random UUID. */
  newId?: () => string;
  /**
   * Default: React Native's `AppState`. `currentState` is read for the launch profile and the
   * drain policy; the runner and the drive host each listen for transitions.
   */
  appState?: AppStateLike & { currentState?: string | null };
  /**
   * The network the runner reads. Default: `createNet()`; if that fails (a build without
   * `expo-network`), never on Wi-Fi — the safe answer: traces wait, summaries go up.
   */
  net?: NetStatus | NetSubscribable;
  /** Default: `createExpoNet` — one adapter per process, shared with the screens (plan D2). */
  createNet?: () => Promise<NetStatus | NetSubscribable>;
  /**
   * The background drain policy, handed to the runner (plan D2, review I3). Default:
   * `drainPolicy` — only while the app is active, or on Android while the headless task runs.
   */
  mayDrain?: () => boolean;
  /** Why this process started. Default: `launchProfile(appState)`, read once, now. */
  profile?: LaunchProfile;
  /** drive-sense, as the host uses it. Default: the native module. */
  source?: DriveSource;
  /**
   * The speed-limit client. Default: the S2 client over the app's Supabase client — built here,
   * but it makes no request until a drive asks for tiles.
   */
  limits?: SpeedLimitClient;
  /** The `speed-limits` edge function seam for the default client. Default: the app client. */
  speedLimitsSupabase?: SpeedLimitsSupabase;
  /** The `app_config` seam for the foreground config fetch. Default: the app client. */
  appConfig?: AppConfigSupabase;
  /**
   * The alert player, given its live inputs (late-bound to the host). Default: P2's player over
   * the expo-audio/speech/haptics ports.
   */
  createPlayer?: (inputs: ReturnType<typeof playerInputs>) => Promise<AlertPlayer>;
  /**
   * The remote `auto_detect` flag (D2). It only makes auto-detect *available*: the host arms only
   * when the driver's own opt-in (`drive.autoDetect`, default false) is also on (D2 security M-2).
   * Default: the stored config, available when nothing was fetched yet.
   */
  readFlag?: (key: 'auto_detect') => Promise<boolean>;
  /**
   * M4's seam: told on every native wake that arrives while the app is not in front, so a
   * permission that lapsed in the background reaches the driver. Default: nothing (M4 fills it).
   */
  reportPermissionsFromBackground?: () => void | Promise<void>;
  /** The identity stage's bound on `getSession()`. Default: `SESSION_TIMEOUT_MS`. */
  sessionTimeoutMs?: number;
  /**
   * The driver a handover already knows (the owner watch saw them sign in). The identity stage
   * decides on this uid with no session read and no timeout, so a handover always wipes (security
   * review H2 I-1 a).
   */
  expectedUid?: string;
  /**
   * U5's battery recorder, mounted on the started host in every launch profile; returns its
   * unsubscribe, called at `stop()`. Default: in a diagnostics build only (`diagnosticsEnabled()`),
   * `createDriveBatteryRecorder` — two one-shot readings per real drive, never a poll. `null`:
   * none.
   */
  mountDiagnostics?:
    | ((host: DriveHost, db: Db, onError: (error: unknown) => void) => () => void)
    | null;
  /**
   * U3's drive-summary notifier, attached to the started host in every launch profile — so a drive
   * finalized with no layout mounted (the Android headless task, an iOS background launch) still
   * schedules its summary. Attaching twice is safe (the layout's routing hook attaches too).
   * Default: `attachSummaryNotifier`. `null`: none.
   */
  attachSummaryNotifier?: ((host: DriveHost) => { detach(): void }) | null;
  /** iOS backup exclusion (plan R4). Default: drive-sense's `excludeFromBackup`. */
  excludeFromBackup?: (uri: string) => Promise<void>;
  /** The directory the database lives in. Default: expo-sqlite's `defaultDatabaseDirectory`. */
  databaseDirectory?: string;
  queryClient?: QueryClient;
  /** The launch deadline. Default: `BOOTSTRAP_TIMEOUT_MS`. */
  timeoutMs?: number;
  now?: () => number;
  /** IANA zone. Default: the device's. */
  tz?: string;
  /** Told about failures that did not change the outcome. Default: a development warning. */
  onError?: (error: unknown, context: string) => void;
}

export interface AppRuntime {
  db: Db;
  queryClient: QueryClient;
  runner: SyncRunner;
  /** Restores the driver's history from the server. Idle until `startForegroundJobs`. */
  hydrator: Hydrator;
  /** The drive host (H1), started: it adopted what it could, subscribed, and armed if allowed. */
  drive: DriveHost;
  /** The speed-limit client the host uses; the foreground jobs purge its expired tiles. */
  limits: SpeedLimitClient;
  /** Why this process started (read once, at boot). */
  profile: LaunchProfile;
  /** The interrupted drive the host continued, or null. */
  adopted: string | null;
  /**
   * Every orphan handled at this launch: `recovered`/`discarded`/`failed` across both recovery
   * passes; `skipped` holds the one the host adopted (at most one) — everything else was handled.
   */
  recovery: RecoveryResult;
  /** What the owner check found. `wiped` means this launch emptied a previous driver's device. */
  owner: DeviceOwnerOutcome;
  schemaVersion: number;
  /** The clock the launch was built with; the foreground jobs throttle by it. */
  now: () => number;
  /** Fetch the public config (feature flags) once; rejects on failure. For the foreground job. */
  refreshConfig(): Promise<void>;
  /**
   * Stops the runner and the hydrator, then the drive host, detaches the cache from the change
   * event and empties it. For teardown; never mid-session. The cache is emptied rather than left to
   * its gc timers because one reason to tear a runtime down is that the device changed hands, and
   * the last driver's rows must not sit in memory for five more minutes.
   *
   * `endOpenTrip` (default true) ends and finalizes a drive that is still open — a handover's
   * rebuild: that drive is queued under the previous owner, and the next launch's wipe removes it
   * (M2 open decision 2, the known trade — not a rescue). False leaves it `recording` for the next
   * launch to adopt: a launch abandoned at its deadline, whose retry should continue the drive.
   * The runner is stopped first, so the finalize's enqueue wakes no drain.
   */
  stop(opts?: { endOpenTrip?: boolean }): Promise<void>;
}

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function warn(error: unknown, context: string): void {
  if (__DEV__) console.warn(`[bootstrap] ${context}:`, error);
}

/**
 * The whole launch, with the deadline (`M-4`) around it.
 *
 * A *failure* at any step is already answered; a *hang* — a stuck `openDb`, a migration grinding
 * through a large database — is not, and it holds the splash forever with no words and no exit.
 * Past the deadline the launch is reported as a failure at whichever step it had reached, and a
 * sequence that comes back later is nobody's: it is shut down rather than left with a started
 * runner and a live subscriber behind it.
 */
export async function bootstrapApp(deps: BootstrapDeps = {}): Promise<AppRuntime> {
  const limitMs = deps.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  let reached: BootstrapStage = 'open';
  let abandoned = false;

  const sequence = runLaunch(deps, (name) => {
    reached = name;
  });
  sequence.then(
    (runtime) => {
      // An open drive is left `recording`: the retry's launch adopts it rather than ending it.
      if (abandoned) void runtime.stop({ endOpenTrip: false });
    },
    // The deadline already reported it; a second rejection here would be unhandled.
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

async function runLaunch(
  deps: BootstrapDeps,
  enter: (name: BootstrapStage) => void
): Promise<AppRuntime> {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? warn;
  const appState = deps.appState ?? AppState;
  const profile = deps.profile ?? launchProfile(appState);
  const zone = deps.tz ?? deviceZone();

  enter('open');
  const db = await stage('open', () => (deps.openDb ?? (() => createExpoDb(DB_NAME)))());
  // The directory exists now. Not awaited: an attribute on a folder must not hold the splash, and
  // a refusal (drive-sense E_NOT_FOUND/E_IO, or no native module) only costs a backup copy.
  void excludeDatabaseFromBackup(deps).catch((error: unknown) =>
    onError(error, 'exclude database from backup')
  );
  enter('migrate');
  const schemaVersion = await stage('migrate', () => migrate(db));

  // Before anything reads a row: a device that changed hands is emptied here, so recovery cannot
  // finalize the last driver's interrupted drive into this one's account (`src/boot/device.ts`).
  enter('identity');
  const identity = await stage('identity', async () => {
    const { supabase, hydrateSupabase } = deps.supabase
      ? { supabase: deps.supabase, hydrateSupabase: deps.supabase }
      : appSeams((await import('@/data/supabase/client')).supabase);
    const traceWriter =
      deps.traceWriter ?? (await createExpoTraceWriter(undefined, undefined, undefined, onError));
    const decide = (uid: string | null) =>
      ensureDeviceOwner(db, uid, { traces: traceWriter, onError });
    if (deps.expectedUid !== undefined) {
      // A handover's rebuild: the new driver is known. No network, no timeout — it always wipes.
      return { supabase, hydrateSupabase, traceWriter, owner: await decide(deps.expectedUid) };
    }
    const sessionMs = deps.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
    const reading = supabase.auth.getSession();
    const session = await withinMs(reading, sessionMs);
    let owner: DeviceOwnerOutcome;
    if (session !== TIMED_OUT) {
      owner = await decide(session.data.session?.user.id ?? null);
    } else if (await ownerMayHaveChanged(db)) {
      // A timeout is `same` only when nothing says the owner changed (H2 I-1 b). Here something
      // does — a runner has seen a different signed-in user — so nothing is mounted, recovered or
      // started until the session answers; the launch deadline bounds the wait, and a launch
      // that fails here fails closed, with its retry.
      onError(new Error(`getSession did not answer within ${sessionMs} ms`), 'identity: session');
      owner = await decide((await reading).data.session?.user.id ?? null);
    } else {
      // No answer (a token refresh with no network, typically on a background wake) and no sign
      // of another driver. The engine must not wait for the radio, and a guess never wipes: the
      // device stays whoever's it was. The live owner watch and the next launch settle it.
      owner = (await readDeviceOwner(db)) === null ? 'signed-out' : 'same';
      onError(new Error(`getSession did not answer within ${sessionMs} ms`), 'identity: session');
    }
    return { supabase, hydrateSupabase, traceWriter, owner };
  });

  const newId = deps.newId ?? (await import('@/lib/ids')).newClientTripId;
  const hash = deps.hash ?? { sha256: (await import('@/lib/hash')).sha256Hex };
  const source = deps.source ?? nativeDriveSource;
  // Built before recovery (H2 r1): a crash-recovered drive is judged against the stored tiles
  // exactly as an adopted one is. Building it makes no request; only a drive's `startTrip` does.
  const limits = deps.limits ?? defaultLimits(db, deps, now, onError);
  const recoveryDeps: Omit<RecoveryDeps, 'skip'> = {
    scoring,
    tz: zone,
    fs: identity.traceWriter,
    hash,
    now,
    createDetectors: () => createDetectors(newId),
    // SQLite only, never the network: `lookupStored` reads what the device already holds.
    limits: { lookup: (lat, lng, course) => limits.lookupStored(lat, lng, course) },
  };

  enter('recover');
  const recovery = await stage('recover', async () => {
    const adoptable = createAdoptableCheck(source, now, onError);
    return recoverRecordingTrips(db, { ...recoveryDeps, skip: adoptable });
  });

  enter('engine');
  const engine = await stage('engine', async () => {
    let host: DriveHost | undefined;
    // Sound that will not load must not cost the drive, and must not be silent to the driver
    // either: the host publishes `alertsAvailable: false` and the HUD says so (H2 r1).
    let player: AlertPlayer;
    let alertsAvailable = true;
    try {
      player = await (deps.createPlayer ?? defaultPlayer(onError))(playerInputs(() => host));
    } catch (error) {
      // M-3: the error's kind only — nothing its message might carry (a position, a trip id).
      const kind = error instanceof Error ? error.name : typeof error;
      onError(new Error(`alert sound could not be loaded (${kind})`), 'alert ports');
      alertsAvailable = false;
      player = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} };
    }
    const drive = createDriveHost({
      db,
      source: withBackgroundWakeReport(
        source,
        appState,
        deps.reportPermissionsFromBackground,
        onError
      ),
      limits,
      player,
      scoring,
      traceWriter: identity.traceWriter,
      hash,
      now,
      tz: () => zone,
      newId,
      readFlag: deps.readFlag ?? ((key) => readFlag(db, key, AUTO_DETECT_FLAG_FALLBACK)),
      appState,
      alertsAvailable,
      onError: (error, context) => onError(error, `drive ${context}`),
    });
    host = drive;

    // Oldest first; only the newest can still be the drive under way. Anything older that was
    // skipped is finalized now, before the host exists as a live owner of any `recording` row.
    const skipped = recovery.skipped;
    const newest = skipped.length > 0 ? (skipped[skipped.length - 1] as string) : null;
    const older = new Set(skipped.slice(0, -1));
    const passes: RecoveryResult[] = [];
    if (older.size > 0) {
      passes.push(
        await recoverRecordingTrips(db, {
          ...recoveryDeps,
          skip: (trip) => !older.has(trip.client_trip_id),
        })
      );
    }

    const adoptRow: TripRow | null = newest === null ? null : await createTripsRepo(db).get(newest);
    const { adopted } = await drive.start({ adopt: adoptRow });
    try {
      if (newest !== null && !adopted) {
        // E1 protocol: not adopted (no samples, or the engine was not idle) → finalized without
        // `skip`, now. Only that trip: a drive the host has opened since is its own.
        passes.push(
          await recoverRecordingTrips(db, {
            ...recoveryDeps,
            skip: (trip) => trip.client_trip_id !== newest,
          })
        );
      }
    } catch (error) {
      // A started host must not outlive a launch that failed: its listeners go, and an adopted
      // drive stays `recording` for the retry to adopt again.
      void drive.stop({ endOpenTrip: false });
      throw error;
    }

    // Neither can fail the launch: a failure is reported and the drive runs without it.
    const attach =
      deps.attachSummaryNotifier === undefined ? defaultSummaryNotifier : deps.attachSummaryNotifier;
    let notifier: { detach(): void } | null = null;
    if (attach) {
      try {
        notifier = attach(drive);
      } catch (error) {
        onError(error, 'summary notifier');
      }
    }
    // After start, so an adopted drive already recording is not taken for a new one's start.
    let unmountDiagnostics: () => void = () => {};
    const mount = deps.mountDiagnostics === undefined ? defaultDiagnostics : deps.mountDiagnostics;
    if (mount) {
      try {
        unmountDiagnostics = mount(drive, db, (error) => onError(error, 'diagnostics battery'));
      } catch (error) {
        onError(error, 'diagnostics battery');
      }
    }
    const release = () => {
      unmountDiagnostics();
      notifier?.detach();
    };
    return { drive, limits, adopted: adopted ? newest : null, passes, release };
  });

  const outcome: RecoveryResult = {
    recovered: [...recovery.recovered, ...engine.passes.flatMap((p) => p.recovered)],
    discarded: [...recovery.discarded, ...engine.passes.flatMap((p) => p.discarded)],
    failed: [...recovery.failed, ...engine.passes.flatMap((p) => p.failed)],
    skipped: engine.adopted === null ? [] : [engine.adopted],
  };
  for (const failure of outcome.failed) onError(failure.error, `recover ${failure.clientTripId}`);

  const queryClient = deps.queryClient ?? createQueryClient();
  const detach = subscribeInvalidation(queryClient);
  // Recording *or finalizing*: `finalizeTrip` enqueues inside its transaction, and a drain woken
  // by that enqueue must wait for the finalize change that follows (H1 report).
  const isBusy = () => engine.drive.isBusy();

  enter('sync');
  let runner: SyncRunner | null = null;
  let traceFs: TraceFs | null = null;
  try {
    const created = await stage('sync', async () => {
      traceFs = deps.traceFs ?? (await createExpoTraceFs());
      const net = deps.net ?? (await networkOrNeverWifi(deps.createNet ?? createExpoNet, onError));
      return createSyncRunner({
        db,
        supabase: identity.supabase,
        fs: traceFs,
        net,
        mayDrain: deps.mayDrain ?? drainPolicy({ appState }),
        isRecording: isBusy,
        appState,
        now,
        onError,
      });
    });
    runner = created;
    // Inside the stage as well: a `start()` that throws is a launch that failed at `sync`, not
    // an untagged error escaping the sequence.
    await stage('sync', async () => created.start());
  } catch (reason) {
    // Nothing this step attached may outlive it. The layout offers a retry that re-runs the
    // whole sequence, and a subscriber left behind would fire `invalidateAfterSync` into a
    // `QueryClient` nobody will ever render — once per press, forever. The host lets go of its
    // native listeners too; a drive it adopted stays `recording` for the retry to adopt.
    void runner?.stop();
    engine.release();
    void engine.drive.stop({ endOpenTrip: false });
    detach();
    throw reason;
  }

  // Built here so it shares the launch's identity, clock and busy signal; started by nobody here.
  const hydrator = createHydrator({
    db,
    supabase: identity.hydrateSupabase,
    now,
    isBusy,
    onError,
    // Reconciliation removes a drive deleted elsewhere, trace file included.
    fs: traceFs ?? undefined,
  });

  return {
    db,
    queryClient,
    runner,
    hydrator,
    drive: engine.drive,
    limits: engine.limits,
    profile,
    adopted: engine.adopted,
    recovery: outcome,
    owner: identity.owner,
    schemaVersion,
    now,
    async refreshConfig() {
      const seam = deps.appConfig ?? (await import('@/data/supabase/client')).supabase;
      const flag = () => readFlag(db, 'auto_detect', AUTO_DETECT_FLAG_FALLBACK);
      const before = await flag();
      await refreshAppConfig(seam, db, now);
      // A changed flag re-applies the host's arming, so Home and the host never disagree: a
      // withdrawn flag disarms; a restored one re-arms only a driver who opted in. The driver's
      // own choice is re-stated unchanged, never altered by the server.
      if ((await flag()) !== before) await engine.drive.setAutoDetect(engine.drive.autoDetectEnabled());
    },
    async stop(opts = {}) {
      await Promise.all([runner.stop(), hydrator.stop()]);
      // The drive a handover ends is still announced: the notifier lets go only after its finalize.
      await engine.drive.stop({ endOpenTrip: opts.endOpenTrip ?? true });
      engine.release();
      detach();
      queryClient.clear();
    },
  };
}

const TIMED_OUT = Symbol('timed out');

/**
 * Whether anything on the device says its owner may have changed — the signals that make a
 * session timeout unsafe to read as `same` (H2 I-1 b, R1-M1):
 *   - a runner recorded a signed-in user (`session.uid`) other than the recorded owner, or
 *   - the owner watch marked a handover that no launch has settled (`PENDING_OWNER_KEY`), which
 *     covers a process killed between the sign-in and its rebuild, before any runner read B.
 */
async function ownerMayHaveChanged(db: Db): Promise<boolean> {
  const settings = createSettingsRepo(db);
  const owner = await readDeviceOwner(db);
  const seen = await settings.get<string>(SESSION_UID_KEY);
  const pending = await settings.get<string>(PENDING_OWNER_KEY);
  return (seen !== null && seen !== owner) || (pending !== null && pending !== owner);
}

/** `promise`, or `TIMED_OUT` after `ms`; the timer is cleared either way (no timer outlives it). */
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
 * Recovery's `skip` (plan H2, rev1: I2): leave a trip for the host to adopt when it was
 * checkpointed inside the gap window AND the drive looks to be going on — native is capturing,
 * a capture was open when the process ended, or the motion history since the checkpoint contains
 * automotive (an iOS relaunch on a wake, before capture restarted).
 *
 * Native is asked once per launch (`getState`), and only when there is an orphan to judge; the
 * motion history only when the state alone does not settle it. A native read that fails counts as
 * "no sign of a drive": the trip is finalized, which loses nothing but the continuation.
 */
function createAdoptableCheck(
  source: Pick<DriveSource, 'getState' | 'queryMotionHistory'>,
  now: () => number,
  onError: (error: unknown, context: string) => void
): (trip: TripRow) => Promise<boolean> {
  let state: Promise<DriveSenseState | null> | null = null;
  const readState = () =>
    (state ??= source.getState().catch((error: unknown) => {
      onError(error, 'recover: drive-sense state');
      return null;
    }));
  return async (trip) => {
    const checkpoint = trip.checkpoint_ts;
    const at = now();
    if (checkpoint === null || at - checkpoint > scoring.CONSTANTS.GAP_MERGE_S * 1000) return false;
    const native = await readState();
    if (native?.capturing || native?.captureWasOpen) return true;
    try {
      const history = await source.queryMotionHistory(checkpoint, at);
      return history.some((a) => a.type === 'automotive');
    } catch (error) {
      onError(error, 'recover: motion history');
      return false;
    }
  };
}

/**
 * drive-sense as the host sees it, with M4's seam on the wake: a wake that arrives while the app
 * is not in front also tells `report` (without delaying the host's own handling of it). Every
 * method is delegated explicitly: the native module is a host object whose methods do not spread.
 */
function withBackgroundWakeReport(
  source: DriveSource,
  appState: { currentState?: string | null },
  report: (() => void | Promise<void>) | undefined,
  onError: (error: unknown, context: string) => void
): DriveSource {
  if (!report) return source;
  const tell = () => {
    if (appState.currentState === 'active') return;
    Promise.resolve()
      .then(report)
      .catch((error: unknown) => onError(error, 'report permissions from background'));
  };
  return {
    arm: () => source.arm(),
    disarm: () => source.disarm(),
    startCapture: (mode) => source.startCapture(mode),
    stopCapture: () => source.stopCapture(),
    setCaptureRate: (rate) => source.setCaptureRate(rate),
    getState: () => source.getState(),
    queryMotionHistory: (from, to) => source.queryMotionHistory(from, to),
    setNotificationState: (state) => source.setNotificationState(state),
    addListener<E extends DriveSenseEvent>(
      event: E,
      fn: (payload: DriveSenseEvents[E]) => void
    ): Subscription {
      if (event !== 'wake') return source.addListener(event, fn);
      return source.addListener(event, (payload) => {
        tell();
        fn(payload);
      });
    },
  };
}

/** The S2 client over the edge function. The function client is imported on the first request. */
function defaultLimits(
  db: Db,
  deps: BootstrapDeps,
  now: () => number,
  onError: (error: unknown, context: string) => void
): SpeedLimitClient {
  let api: Promise<SpeedLimitApi> | null = null;
  const load = () =>
    (api ??= (async () =>
      createSupabaseSpeedLimitApi(
        deps.speedLimitsSupabase ?? (await import('@/data/supabase/client')).supabase
      ))());
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

/** U3's notifier. Required lazily: expo-notifications is loaded only by a launch that needs it. */
function defaultSummaryNotifier(host: DriveHost): { detach(): void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const { attachSummaryNotifier } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
  return attachSummaryNotifier(host);
}

/**
 * U5's battery recorder, only in a diagnostics build. The screen module is required lazily and only
 * here: it is where `diagnosticsEnabled()` lives, and nothing else of it runs.
 */
function defaultDiagnostics(host: DriveHost, db: Db, onError: (error: unknown) => void): () => void {
  /* eslint-disable @typescript-eslint/no-require-imports -- deferred: the dev screens' modules */
  const { diagnosticsEnabled } =
    require('@/features/dev/flags') as typeof import('@/features/dev/flags');
  if (!diagnosticsEnabled()) return () => {};
  const { createDriveBatteryRecorder } =
    require('@/features/dev/battery') as typeof import('@/features/dev/battery');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return createDriveBatteryRecorder({ host, settings: createSettingsRepo(db), onError });
}

/**
 * P2's player over the device ports. A port that will not load rejects; the engine stage then
 * records without sound and says so (`alertsAvailable: false`).
 */
function defaultPlayer(
  onError: (error: unknown, context: string) => void
): (inputs: ReturnType<typeof playerInputs>) => Promise<AlertPlayer> {
  return async (inputs) =>
    createAlertPlayer({
      ...(await createExpoAlertPorts()),
      voiceEnabled: () => true,
      ...inputs,
      onError: (error) => onError(error, 'alert player'),
    });
}

/** iOS: keep the database — the driver's whole local history — out of iCloud and Finder backups. */
async function excludeDatabaseFromBackup(deps: BootstrapDeps): Promise<void> {
  const directory =
    deps.databaseDirectory ?? ((await import('expo-sqlite')).defaultDatabaseDirectory as string);
  const exclude =
    deps.excludeFromBackup ??
    (async (uri: string) => (await import('@drive-sense')).default.excludeFromBackup(uri));
  await exclude(directory);
}

/** The network adapter, or — when it cannot be made — a network that is never on Wi-Fi. */
async function networkOrNeverWifi(
  create: () => Promise<NetStatus | NetSubscribable>,
  onError: (error: unknown, context: string) => void
): Promise<NetStatus | NetSubscribable> {
  try {
    return await create();
  } catch (error) {
    onError(error, 'network adapter');
    return { isWifi: () => false };
  }
}

/**
 * The app client as the two seams the launch hands out. The runner's is a plain structural
 * assignment (its test proves the client fits). The hydrator's goes through `hydrateSeam`, the one
 * place the generated client's schema-resolved builder is narrowed to the restore's six calls.
 */
function appSeams(client: SupabaseClient<Database>): {
  supabase: SyncSupabase;
  hydrateSupabase: HydrateSupabase;
} {
  return { supabase: client, hydrateSupabase: hydrateSeam(client) };
}

export interface ForegroundJobsDeps {
  /** Default: React Native's `AppState`. */
  appState?: ForegroundAppState;
  onError?: (error: unknown, context: string) => void;
}

/**
 * The work that runs only while the driver has the app open (R10, R13; review I3). The controller
 * (`./controller.ts`) calls this once the app is active — never from a background wake or the
 * headless task — and awaits the returned `stop()` when the runtime is torn down.
 *
 * Three jobs, each on a transition to `active` and throttled by a settings stamp:
 *   - **hydration**, every `HYDRATE_INTERVAL_MS`, then `limits.purgeExpired()` once the restore
 *     completed (rev1: m — tiles expire, and the purge is SQLite work best done while in front);
 *   - **the public config** (`refreshAppConfig`), every `APP_CONFIG_INTERVAL_MS` — not while a
 *     drive is under way, so a drive never costs a request it does not need.
 *
 * Hydration is an incremental top-up from the stored cursor. A **full** restore is owed once — the throttle
 * bypassed — when this launch found a new owner (`first`, `wiped`) or the device has never
 * completed a restore (an M2 install, or one whose restores were all cut short); it stays owed until a full run completes, so a restore cut short by a
 * tunnel or a drive is resumed at the next foreground rather than six hours later. While it is
 * owed, the score slot says "Restoring…" rather than "Building your score" (R9).
 */
/** What `startForegroundJobs` hands the host. */
export interface ForegroundJobs {
  /** Detach every job from AppState; await it at teardown. A run in flight stamps nothing after. */
  stop(): Promise<void>;
  /**
   * Run the restore now, throttle bypassed — U4's "Couldn't restore your drives — Retry" (review
   * D1 M4). Joins a run already in flight. Resolves true when the run reached the end; never
   * rejects (a failure is reported and the status store says `failed`).
   */
  runNow(): Promise<boolean>;
}

export async function startForegroundJobs(
  runtime: AppRuntime,
  deps: ForegroundJobsDeps = {}
): Promise<ForegroundJobs> {
  const settings = createSettingsRepo(runtime.db);
  const neverRestored = (await settings.get<unknown>(HYDRATE_RESTORED_AT_KEY)) === null;
  let fullOwed = runtime.owner === 'first' || runtime.owner === 'wiped' || neverRestored;
  if (fullOwed) {
    // Bypass the throttle once: a stamp left by an earlier install or owner is not this restore's.
    await settings.remove(foregroundStampKey('hydrate'));
    if (getHydrationStatus().state === 'idle') setHydrationStatus({ state: 'restoring', restored: 0 });
  }

  const onError = deps.onError ?? warn;
  const job = async (): Promise<void> => {
    const result = await runtime.hydrator.run({ full: fullOwed });
    // An incomplete run stamps nothing, so the next foreground tries again.
    if (!result.complete) throw new Error('hydration did not complete');
    fullOwed = false;
    // A failed purge is only tiles kept a little longer; the restore itself is done.
    await runtime.limits.purgeExpired().catch((error: unknown) => onError(error, 'purge expired tiles'));
  };
  const foreground = {
    appState: deps.appState ?? AppState,
    now: runtime.now,
    db: runtime.db,
    onError,
  };
  const stopHydrate = runWhenForeground('hydrate', HYDRATE_INTERVAL_MS, job, foreground);
  const stopConfig = runWhenForeground(
    'config',
    APP_CONFIG_INTERVAL_MS,
    async () => {
      // Thrown, not skipped: a throw stamps nothing, so the next foreground after the drive runs it.
      if (runtime.drive.isBusy()) throw new Error('a drive is under way');
      await runtime.refreshConfig();
    },
    foreground
  );
  return {
    async stop() {
      stopHydrate();
      stopConfig();
    },
    async runNow() {
      try {
        await job();
        return true;
      } catch (error) {
        onError(error, 'foreground job hydrate (run now)');
        return false;
      }
    },
  };
}

/**
 * Before the session ends at sign-out, while it can still send them: every delete this device
 * owes the server (security review D1 M-1). A different driver's sign-in later wipes the device,
 * and with it any delete still queued — which the next restore would then undo. The host calls
 * this from the sign-out action before `supabase.auth.signOut()`; `left` is what the sign-out
 * warning must name (deletes that could not be sent: offline, or given up).
 */
export function flushBeforeSignOut(runtime: AppRuntime): Promise<FlushResult> {
  return runtime.runner.flushDeletes();
}
