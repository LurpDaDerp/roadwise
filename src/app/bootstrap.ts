/**
 * What has to be true before the first screen reads anything (M2 ruling; M3 adds the engine).
 *
 * In order, because each step needs the one before:
 *   1. open SQLite — WAL, foreign keys, the busy timeout (`createExpoDb`);
 *   2. `migrate` to the current schema;
 *   3. `recoverRecordingTrips` — a drive the last process died in is finalized from its last
 *      checkpoint, before any engine exists to own a `recording` row. No speed-limit cache yet,
 *      so a recovered drive is judged against an unknown limit: no speeding, everything else;
 *   4. the query client, wired to the queue's events so a sync pass refreshes what is on screen;
 *   5. the sync runner, started — whatever recovery just queued goes up now.
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

import { createExpoTraceWriter, type TraceWriter } from './traceWriter';

/** The one database file on the device. */
export const DB_NAME = 'roadwise.db';

export type BootstrapStage = 'open' | 'migrate' | 'recover' | 'sync';

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
  schemaVersion: number;
  /** Stops the runner and detaches the cache from the queue. For teardown; never mid-session. */
  stop(): void;
}

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function warn(error: unknown, context: string): void {
  if (__DEV__) console.warn(`[bootstrap] ${context}:`, error);
}

async function stage<T>(name: BootstrapStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (reason) {
    throw new BootstrapError(name, reason);
  }
}

export async function bootstrapApp(deps: BootstrapDeps = {}): Promise<AppRuntime> {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? warn;

  const db = await stage('open', () => (deps.openDb ?? (() => createExpoDb(DB_NAME)))());
  const schemaVersion = await stage('migrate', () => migrate(db));

  const recovery = await stage('recover', async () => {
    const newId = deps.newId ?? (await import('@/lib/ids')).newClientTripId;
    return recoverRecordingTrips(db, {
      scoring,
      tz: deps.tz ?? deviceZone(),
      fs: deps.traceWriter ?? (await createExpoTraceWriter()),
      hash: deps.hash ?? { sha256: (await import('@/lib/hash')).sha256Hex },
      now,
      createDetectors: () => createDetectors(newId),
    });
  });
  for (const failure of recovery.failed) onError(failure.error, `recover ${failure.clientTripId}`);

  const queryClient = deps.queryClient ?? createQueryClient();
  const detach = subscribeInvalidation(queryClient);

  const runner = await stage('sync', async () =>
    createSyncRunner({
      db,
      supabase: deps.supabase ?? (await import('@/data/supabase/client')).supabase,
      fs: deps.traceFs ?? (await createExpoTraceFs()),
      net: deps.net ?? { isWifi: () => false },
      isRecording: deps.isRecording ?? (() => false),
      appState: deps.appState ?? AppState,
      now,
      onError,
    })
  );
  runner.start();

  return {
    db,
    queryClient,
    runner,
    recovery,
    schemaVersion,
    stop() {
      runner.stop();
      detach();
    },
  };
}
