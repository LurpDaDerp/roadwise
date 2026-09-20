/**
 * What has to be true before the first screen reads anything (M2 ruling; M3 adds the engine).
 *
 * In order, because each step needs the one before:
 *   1. open SQLite — WAL, foreign keys, the busy timeout (`createExpoDb`);
 *   2. `migrate` to the current schema;
 *   3. whose device this is — a sign-in by a different user empties it, rows and traces alike,
 *      before any of the last owner's data can be read, recovered or uploaded (`./device.ts`);
 *   4. `recoverRecordingTrips` — a drive the last process died in is finalized from its last
 *      checkpoint, before any engine exists to own a `recording` row. No speed-limit cache yet,
 *      so a recovered drive is judged against an unknown limit: no speeding, everything else;
 *   5. the query client, wired to the queue's events so a sync pass refreshes what is on screen;
 *   6. the sync runner, started — whatever recovery just queued goes up now.
 *
 * Everything platform-shaped is injectable, so the whole sequence runs under Jest against
 * sql.js; the defaults are the device adapters, imported lazily where they carry a native module.
 */
import * as scoring from '@scoring';
import type { QueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';

import { createDetectors } from '@/core/detectors';
import { recoverRecordingTrips, type RecoveryResult } from '@/core/engine/recovery';
import { createExpoDb, migrate, type Db } from '@/data/db';
import { createQueryClient, subscribeInvalidation } from '@/data/queries';
import {
  createSyncRunner,
  type AppStateLike,
  type NetStatus,
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
  /** Default: the app's Supabase client. */
  supabase?: SyncSupabase;
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
   * Default: never on Wi-Fi — no network package is installed yet, and `() => false` is the
   * safe stub (Task 3): traces wait, summaries go up.
   */
  net?: NetStatus;
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
  recovery: RecoveryResult;
  /** What the owner check found. `wiped` means this launch emptied a previous driver's device. */
  owner: DeviceOwnerOutcome;
  schemaVersion: number;
  /**
   * Stops the runner, detaches the cache from the queue and empties it. For teardown; never
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
  enter('migrate');
  const schemaVersion = await stage('migrate', () => migrate(db));

  // Before anything reads a row: a device that changed hands is emptied here, so recovery cannot
  // finalize the last driver's interrupted drive into this one's account (`src/boot/device.ts`).
  enter('identity');
  const identity = await stage('identity', async () => {
    const supabase = deps.supabase ?? (await import('@/data/supabase/client')).supabase;
    const traceWriter = deps.traceWriter ?? (await createExpoTraceWriter());
    const { data } = await supabase.auth.getSession();
    const owner = await ensureDeviceOwner(db, data.session?.user.id ?? null, {
      traces: traceWriter,
      onError,
    });
    return { supabase, traceWriter, owner };
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
  try {
    const created = await stage('sync', async () =>
      createSyncRunner({
        db,
        supabase: identity.supabase,
        fs: deps.traceFs ?? (await createExpoTraceFs()),
        net: deps.net ?? { isWifi: () => false },
        isRecording: deps.isRecording ?? (() => false),
        appState: deps.appState ?? AppState,
        now,
        onError,
      })
    );
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

  return {
    db,
    queryClient,
    runner,
    recovery,
    owner: identity.owner,
    schemaVersion,
    async stop() {
      await runner.stop();
      detach();
      queryClient.clear();
    },
  };
}
