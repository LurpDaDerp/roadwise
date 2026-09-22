/**
 * What has to be true before the first screen reads anything (M2 ruling; M3 adds the engine).
 *
 * In order, because each step needs the one before:
 *   1. open SQLite — WAL, foreign keys, the busy timeout (`createExpoDb`) — and exclude its
 *      directory from iOS backups (plan R4, D2; not awaited, and a failure is only reported);
 *   2. `migrate` to the current schema;
 *   3. whose device this is — a sign-in by a different user empties it, rows and traces alike,
 *      before any of the last owner's data can be read, recovered or uploaded (`./device.ts`);
 *   4. `recoverRecordingTrips` — a drive the last process died in is finalized from its last
 *      checkpoint, before any engine exists to own a `recording` row. No speed-limit cache yet,
 *      so a recovered drive is judged against an unknown limit: no speeding, everything else;
 *   5. the query client, wired to the one change event so a sync pass, a restore or a finalize
 *      refreshes what is on screen;
 *   6. the sync runner, started — whatever recovery just queued goes up now;
 *   7. the hydrator, built but **not** started: restoring history from the server is network
 *      work, and a background launch (an iOS location wake, the Android headless task) must not
 *      do it (R13). The host calls `startForegroundJobs(runtime)` from the foreground path, which
 *      runs it only while the app is active and at most every `HYDRATE_INTERVAL_MS`.
 *
 * Everything platform-shaped is injectable, so the whole sequence runs under Jest against
 * sql.js; the defaults are the device adapters, imported lazily where they carry a native module.
 */
import * as scoring from '@scoring';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

import { createDetectors } from '@/core/detectors';
import { recoverRecordingTrips, type RecoveryResult } from '@/core/engine/recovery';
import { createExpoDb, migrate, type Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { createExpoNet } from '@/data/net/net';
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
import { createExpoTraceFs } from '@/data/sync/traceFs';

import { ensureDeviceOwner, type DeviceOwnerOutcome } from './device';
import { createExpoTraceWriter, type TraceWriter } from './traceWriter';

/** The one database file on the device. */
export const DB_NAME = 'roadwise.db';

/**
 * How long the whole launch may take before the driver is told it failed. Generous: a first
 * migration on a slow device is seconds, not milliseconds, and a false alarm costs a retry.
 */
export const BOOTSTRAP_TIMEOUT_MS = 20_000;

export type BootstrapStage = 'open' | 'migrate' | 'identity' | 'recover' | 'sync';

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
  /** Default: React Native's `AppState`. */
  appState?: AppStateLike;
  /**
   * The network the runner reads. Default: `createNet()`; if that fails (a build without
   * `expo-network`), never on Wi-Fi — the safe answer: traces wait, summaries go up.
   */
  net?: NetStatus | NetSubscribable;
  /** Default: `createExpoNet` — one adapter per process, shared with the screens (plan D2). */
  createNet?: () => Promise<NetStatus | NetSubscribable>;
  /**
   * The host's background drain policy, handed to the runner (plan D2, review I3). Default: the
   * runner's own, which is always.
   */
  mayDrain?: () => boolean;
  /** iOS backup exclusion (plan R4). Default: drive-sense's `excludeFromBackup`. */
  excludeFromBackup?: (uri: string) => Promise<void>;
  /** The directory the database lives in. Default: expo-sqlite's `defaultDatabaseDirectory`. */
  databaseDirectory?: string;
  /** Default: no engine exists yet, so nothing is ever recording. M3 hands over the engine's status. */
  isRecording?: () => boolean;
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
  recovery: RecoveryResult;
  /** What the owner check found. `wiped` means this launch emptied a previous driver's device. */
  owner: DeviceOwnerOutcome;
  schemaVersion: number;
  /** The clock the launch was built with; the foreground jobs throttle by it. */
  now: () => number;
  /**
   * Stops the runner and the hydrator, detaches the cache from the change event and empties it. For teardown; never
   * mid-session. The cache is emptied rather than left to its gc timers because one reason to
   * tear a runtime down is that the device changed hands, and the last driver's rows must not
   * sit in memory for five more minutes.
   */
  stop(): Promise<void>;
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
      if (abandoned) void runtime.stop();
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
    const { data } = await supabase.auth.getSession();
    const owner = await ensureDeviceOwner(db, data.session?.user.id ?? null, {
      traces: traceWriter,
      onError,
    });
    return { supabase, hydrateSupabase, traceWriter, owner };
  });

  enter('recover');
  const recovery = await stage('recover', async () => {
    const newId = deps.newId ?? (await import('@/lib/ids')).newClientTripId;
    return recoverRecordingTrips(db, {
      scoring,
      tz: deps.tz ?? deviceZone(),
      fs: identity.traceWriter,
      hash: deps.hash ?? { sha256: (await import('@/lib/hash')).sha256Hex },
      now,
      createDetectors: () => createDetectors(newId),
      // `limits` is deliberately absent: no tile cache exists at launch, so every replayed row
      // is judged against `UNKNOWN_LIMIT` — no speeding without a limit, everything else.
    });
  });
  for (const failure of recovery.failed) onError(failure.error, `recover ${failure.clientTripId}`);

  const queryClient = deps.queryClient ?? createQueryClient();
  const detach = subscribeInvalidation(queryClient);

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
        mayDrain: deps.mayDrain,
        isRecording: deps.isRecording ?? (() => false),
        appState: deps.appState ?? AppState,
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
    // `QueryClient` nobody will ever render — once per press, forever.
    void runner?.stop();
    detach();
    throw reason;
  }

  // Built here so it shares the launch's identity, clock and busy signal; started by nobody here.
  const hydrator = createHydrator({
    db,
    supabase: identity.hydrateSupabase,
    now,
    isBusy: deps.isRecording ?? (() => false),
    onError,
    // Reconciliation removes a drive deleted elsewhere, trace file included.
    fs: traceFs ?? undefined,
  });

  return {
    db,
    queryClient,
    runner,
    hydrator,
    recovery,
    owner: identity.owner,
    schemaVersion,
    now,
    async stop() {
      await Promise.all([runner.stop(), hydrator.stop()]);
      detach();
      queryClient.clear();
    },
  };
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
 * The work that runs only while the driver has the app open (R10, R13; review I3). H2 calls this
 * from the foreground path of the launch — never from a background wake — and calls the returned
 * function when the runtime is torn down.
 *
 * Today that is hydration: every `HYDRATE_INTERVAL_MS`, on a transition to `active`, an
 * incremental top-up from the stored cursor. A **full** restore is owed once — the throttle
 * bypassed — when this launch found a new owner (`first`, `wiped`) or the device has never
 * completed a restore (an M2 install, or one whose restores were all cut short); it stays owed until a full run completes, so a restore cut short by a
 * tunnel or a drive is resumed at the next foreground rather than six hours later. While it is
 * owed, the score slot says "Restoring…" rather than "Building your score" (R9).
 */
/** What `startForegroundJobs` hands the host. */
export interface ForegroundJobs {
  /** Detach from AppState; call at teardown. */
  stop(): void;
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
  };
  const stop = runWhenForeground('hydrate', HYDRATE_INTERVAL_MS, job, {
    appState: deps.appState ?? AppState,
    now: runtime.now,
    db: runtime.db,
    onError,
  });
  return {
    stop,
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
