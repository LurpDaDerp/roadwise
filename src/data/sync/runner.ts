// The sync runner (design §4.4, §18.4): the device half of the upload.
//
// It drains the `sync_queue` the engine fills. Per finalized trip: the gzip trace goes to
// Storage under the *signed-in user's* prefix, then `POST functions/v1/finalize-trip` sends the
// queued payload verbatim, then the server's answer is written back to SQLite — the trip becomes
// `synced` with its server id, score and status, and the day evaluation lands in
// `score_daily_cache` so the home screen has today's badges offline.
//
// Everything platform-shaped is injected (`fs`, `net`, `appState`, `isRecording`, the Supabase
// client), so the whole runner executes under Jest against sql.js and a recording double. The
// rules it enforces, and why each exists:
//
// - **The summary comes first, the file may follow.** A trace is a few megabytes; a summary is
//   a few kilobytes. On cellular with `sync.wifiOnlyTraces` on, the trip is finalized at once
//   and the file is queued under `trace:<id>` for the next Wi-Fi. The payload is sent exactly as
//   queued — `tracePath` included — because the server never reads the object.
// - **The object key comes from the session, never from the payload** (§4.7): no client-supplied
//   identifier decides where a file lands. `upsert: false`, so an object already there is a 409,
//   which counts as uploaded rather than as a failure.
// - **The upload is remembered before the call that follows it** (`trace_uploaded_at`), so a
//   crash in between costs one call, not one file.
// - **Never while the engine is recording or finalizing.** A drain competes for SQLite's single
//   write lock with the 1 Hz recorder; `database is locked` is treated as "later", never as a
//   failed attempt, and stops the pass.
// - **A claim is only ever closed by the pass that holds it.** `markAttempt` returns null when
//   another pass has closed it, and the item is then abandoned untouched — no failure recorded,
//   no trip row rewritten.
import type { Db } from '@/data/db/driver';
import { createQueueRepo, RECLAIM_AFTER_S } from '@/data/db/queue';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { QueueItem, TripPatch } from '@/data/db/types';
import { isSyncKind, type SyncKind } from '@/data/sync/kinds';
import { FinalizeTripPayloadSchema, type FinalizeTripPayload } from '@/data/sync/payload';
import {
  enqueueTraceUpload,
  onQueueChanged,
  TraceUploadPayloadSchema,
  type TraceUploadPayload,
} from '@/data/sync/queue';
import {
  classifyInvokeError,
  classifyStorageError,
  dayKeyOf,
  FinalizeResponseSchema,
  isDatabaseLocked,
  type Failure,
} from '@/data/sync/response';

/** Storage bucket the traces live in; its policies scope a user to their own `<uid>/` prefix. */
export const TRACES_BUCKET = 'traces';
/** The edge function this runner calls for a finished trip. */
export const FINALIZE_FUNCTION = 'finalize-trip';
/** Settings key: upload traces only on Wi-Fi. On by default — a trace is megabytes of cellular. */
export const WIFI_ONLY_TRACES_KEY = 'sync.wifiOnlyTraces';
export const WIFI_ONLY_TRACES_DEFAULT = true;
/** How long a trace waiting for Wi-Fi sits before the runner asks about the network again. */
export const WIFI_RETRY_S = 900;
/** How long an item whose kind has no handler yet waits before being looked at again. */
export const UNHANDLED_KIND_RETRY_S = 3600;
/** After a wake declined because the engine was recording, try again this long after. */
export const RECORDING_RETRY_MS = 15_000;
/** Items claimed per pass. */
export const DEFAULT_BATCH = 10;

/** The object key under the traces bucket: the user's own prefix, then the trip. */
export const traceObjectKey = (uid: string, clientTripId: string): string =>
  `${uid}/${clientTripId}.bin.gz`;

/** What a trace file can be handed to Storage as; the adapter picks whatever the platform uploads best. */
export type TraceBody = Uint8Array | ArrayBuffer | Blob | string;

/** The traces directory, as the finalizer's `writeGzip` counterpart sees it. */
export interface TraceFs {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<TraceBody>;
  /** Remove the local trace. A file that is already gone is not an error. */
  remove(path: string): Promise<void>;
}

export interface NetStatus {
  /** Whether the device is on Wi-Fi right now. Cellular, metered or unknown is `false`. */
  isWifi(): boolean | Promise<boolean>;
}

/** The shape of React Native's `AppState`, so the host can pass it straight in. */
export interface AppStateLike {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/**
 * The slice of `@supabase/supabase-js` the runner uses. Structural, so the real client is
 * assignable and a test double needs nothing but these four methods.
 */
export interface SyncSupabase {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null } }>;
    refreshSession(): Promise<{ data: { session: { user: { id: string } } | null } }>;
  };
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: TraceBody,
        options: { contentType?: string; upsert?: boolean }
      ): Promise<{ data: unknown; error: unknown }>;
    };
  };
  functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> }
    ): Promise<{ data: unknown; error: unknown }>;
  };
}

export interface SyncRunnerDeps {
  db: Db;
  supabase: SyncSupabase;
  fs: TraceFs;
  net: NetStatus;
  /** True while the engine is recording *or finalizing* — the runner stays off the database. */
  isRecording?: () => boolean;
  /** React Native's `AppState`, or nothing in a host that has no foreground to speak of. */
  appState?: AppStateLike;
  now?: () => number;
  batchSize?: number;
  /** Told about anything that went wrong but did not change the outcome (a failed file delete). */
  onError?: (error: unknown, context: string) => void;
}

export interface DrainResult {
  /** Items the server accepted. */
  done: number;
  /** Items the server refused for good. */
  failed: number;
  /** Items left for a later pass, whether or not the attempt counted. */
  deferred: number;
}

export interface SyncRunner {
  drainOnce(now?: number): Promise<DrainResult>;
  start(): void;
  stop(): void;
}

/**
 * What one item's attempt concluded. `defer` hands the claim back without counting an attempt —
 * the work was never tried — which is what keeps a trace waiting for Wi-Fi from walking towards
 * `MAX_ATTEMPTS`.
 */
type Outcome =
  | { kind: 'done' }
  | { kind: 'failed'; code: string }
  | { kind: 'retry'; code: string; retryAfterS?: number | null }
  | { kind: 'unauthorized'; code: string }
  | { kind: 'defer'; until?: number };

type FailureOutcome = Extract<Outcome, { kind: 'failed' | 'retry' | 'unauthorized' }>;

const failureOutcome = (failure: Failure): FailureOutcome =>
  failure.kind === 'terminal'
    ? { kind: 'failed', code: failure.code }
    : failure.kind === 'unauthorized'
      ? { kind: 'unauthorized', code: failure.code }
      : { kind: 'retry', code: failure.code, retryAfterS: failure.retryAfterS };

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const { db, supabase, fs, net } = deps;
  const now = deps.now ?? Date.now;
  const isRecording = deps.isRecording ?? (() => false);
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const report = (error: unknown, context: string): void => deps.onError?.(error, context);

  const queue = createQueueRepo(db);
  const trips = createTripsRepo(db);
  const settings = createSettingsRepo(db);
  const days = createScoreDailyCacheRepo(db);

  let draining = false;
  let started = false;
  let recordingRetry: ReturnType<typeof setTimeout> | null = null;
  const unsubscribes: (() => void)[] = [];

  /** The signed-in user's id, or null when there is no session to upload under. */
  async function currentUid(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  }

  async function refreshSession(): Promise<boolean> {
    try {
      const { data } = await supabase.auth.refreshSession();
      return data.session !== null;
    } catch (error) {
      report(error, 'refreshSession');
      return false;
    }
  }

  /** Traces wait for Wi-Fi unless the driver has said otherwise. */
  async function traceWaitsForWifi(): Promise<boolean> {
    const wifiOnly = await settings.getOr(WIFI_ONLY_TRACES_KEY, WIFI_ONLY_TRACES_DEFAULT);
    if (!wifiOnly) return false;
    return (await net.isWifi()) === false;
  }

  async function removeTrace(path: string): Promise<void> {
    try {
      await fs.remove(path);
    } catch (error) {
      // The object is in Storage; a file that would not delete is disk to reclaim, not a failure.
      report(error, `remove trace ${path}`);
    }
  }

  type UploadOutcome = { kind: 'ok'; uploaded: boolean } | FailureOutcome;

  /**
   * Put the trip's trace in the bucket. `uploaded: false` means there was nothing to upload —
   * the local file is gone (an older build, a cleaned cache), which is not fatal: the server
   * scores from the payload and only ever consults a trace when a dispute asks it to.
   */
  async function uploadTrace(
    uid: string,
    clientTripId: string,
    tracePath: string
  ): Promise<UploadOutcome> {
    if (!(await fs.exists(tracePath))) return { kind: 'ok', uploaded: false };
    const body = await fs.read(tracePath);
    const { error } = await supabase.storage
      .from(TRACES_BUCKET)
      .upload(traceObjectKey(uid, clientTripId), body, {
        contentType: 'application/gzip',
        upsert: false,
      });
    if (!error) return { kind: 'ok', uploaded: true };
    const failure = classifyStorageError(error);
    if (failure.alreadyExists) return { kind: 'ok', uploaded: true };
    return failureOutcome(failure);
  }

  /** Write the server's answer to the trip and cache its day, in one transaction. */
  async function applyFinalize(
    payload: FinalizeTripPayload,
    response: unknown,
    at: number
  ): Promise<void> {
    const result = FinalizeResponseSchema.parse(response);
    const patch: TripPatch = {
      sync_state: 'synced',
      server_id: result.tripId,
      status: result.status,
      sync_error: null,
    };
    if (result.score !== undefined) patch.score = result.score;

    await db.transaction(async (tx) => {
      await trips.update(payload.clientTripId, patch, at, tx);
      if (result.day !== undefined && result.day !== null) {
        await days.put(dayKeyOf(result.day, payload.startedAt, payload.tz), result.day, at, tx);
      }
    });
  }

  /** Per-item state that survives the one retry a 401 buys. */
  interface ItemState {
    traceUploadedAt: number | null;
  }

  async function runFinalize(item: QueueItem, state: ItemState, at: number): Promise<Outcome> {
    const parsed = FinalizeTripPayloadSchema.safeParse(JSON.parse(item.payload_json));
    // Drift between what this build queued and what this build can send. Retrying cannot fix it,
    // and the samples it was built from are long purged.
    if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
    const payload = parsed.data;

    const uid = await currentUid();
    if (uid === null) return { kind: 'defer' };

    if (payload.tracePath !== null && state.traceUploadedAt === null) {
      if (await traceWaitsForWifi()) {
        // The summary goes up now; the file follows under its own key on the next Wi-Fi.
        await enqueueTraceUpload(
          db,
          { clientTripId: payload.clientTripId, tracePath: payload.tracePath },
          at
        );
      } else {
        const upload = await uploadTrace(uid, payload.clientTripId, payload.tracePath);
        if (upload.kind !== 'ok') return upload;
        if (upload.uploaded) {
          await queue.markTraceUploaded(item.id, at);
          state.traceUploadedAt = at;
        }
      }
    }

    const { data, error } = await supabase.functions.invoke(FINALIZE_FUNCTION, { body: payload });
    if (error) return failureOutcome(await classifyInvokeError(error, at));

    await applyFinalize(payload, data, at);
    // Only this item's own upload licenses the delete; a trace still waiting under `trace:<id>`
    // is the other item's to remove once it has actually sent it.
    if (payload.tracePath !== null && state.traceUploadedAt !== null) {
      await removeTrace(payload.tracePath);
    }
    return { kind: 'done' };
  }

  async function runTraceUpload(
    item: QueueItem,
    state: ItemState,
    at: number
  ): Promise<Outcome> {
    const parsed = TraceUploadPayloadSchema.safeParse(JSON.parse(item.payload_json));
    if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
    const payload: TraceUploadPayload = parsed.data;

    const uid = await currentUid();
    if (uid === null) return { kind: 'defer' };
    // Waiting for Wi-Fi is not a failed attempt: it must not walk the item towards MAX_ATTEMPTS.
    if (await traceWaitsForWifi()) return { kind: 'defer', until: at + WIFI_RETRY_S * 1000 };

    if (state.traceUploadedAt === null) {
      const upload = await uploadTrace(uid, payload.clientTripId, payload.tracePath);
      if (upload.kind !== 'ok') return upload;
      if (upload.uploaded) {
        await queue.markTraceUploaded(item.id, at);
        state.traceUploadedAt = at;
      }
    }
    await removeTrace(payload.tracePath);
    return { kind: 'done' };
  }

  function handlerFor(
    kind: SyncKind
  ): ((item: QueueItem, state: ItemState, at: number) => Promise<Outcome>) | null {
    if (kind === 'finalize-trip') return runFinalize;
    if (kind === 'trace-upload') return runTraceUpload;
    // `dispute`, `set-role` and `delete-trip` go through `trip-actions`, which M2 Task 3 does not
    // ship. Leave such an item alone rather than failing work the next build will handle.
    return null;
  }

  /** One item, with the single session refresh a 401 is allowed to buy. */
  async function runItem(item: QueueItem, at: number): Promise<Outcome> {
    if (!isSyncKind(item.kind)) {
      report(new Error(`unknown queue kind ${item.kind}`), `item ${item.id}`);
      return { kind: 'defer', until: at + UNHANDLED_KIND_RETRY_S * 1000 };
    }
    const handler = handlerFor(item.kind);
    if (!handler) return { kind: 'defer', until: at + UNHANDLED_KIND_RETRY_S * 1000 };

    const state: ItemState = { traceUploadedAt: item.trace_uploaded_at };
    let refreshed = false;
    for (;;) {
      const outcome = await handler(item, state, at);
      if (outcome.kind !== 'unauthorized') return outcome;
      if (refreshed || !(await refreshSession())) {
        // Still not signed in after a refresh: the driver has to re-authenticate, which is not
        // this item's fault and not terminal — the queue waits.
        return { kind: 'retry', code: outcome.code };
      }
      refreshed = true;
    }
  }

  /** Close out the claim the way the outcome asks, and count it. */
  async function settle(
    item: QueueItem,
    outcome: Outcome,
    at: number,
    result: DrainResult
  ): Promise<void> {
    switch (outcome.kind) {
      case 'done': {
        const closed = await queue.markAttempt(item.id, true, null, at);
        if (closed) result.done += 1;
        else result.deferred += 1;
        return;
      }
      case 'failed': {
        const closed = await queue.markAttempt(item.id, false, outcome.code, at);
        // Another pass closed this claim: it owns the item now. Touch nothing.
        if (!closed) {
          result.deferred += 1;
          return;
        }
        await queue.markFailed(item.id, outcome.code);
        if (item.kind === 'finalize-trip') await failTrip(item, outcome.code, at);
        result.failed += 1;
        return;
      }
      case 'retry':
      case 'unauthorized': {
        const closed = await queue.markAttempt(item.id, false, outcome.code, at);
        const retryAfterS = outcome.kind === 'retry' ? outcome.retryAfterS : null;
        if (closed && retryAfterS) await queue.deferUntil(item.id, at + retryAfterS * 1000);
        result.deferred += 1;
        return;
      }
      case 'defer': {
        await queue.release(item.id, outcome.until ?? at);
        result.deferred += 1;
        return;
      }
    }
  }

  /** Tell the driver why this trip will not upload. Best effort: the queue item is the record. */
  async function failTrip(item: QueueItem, code: string, at: number): Promise<void> {
    try {
      const payload: unknown = JSON.parse(item.payload_json);
      const id = (payload as { clientTripId?: unknown }).clientTripId;
      if (typeof id !== 'string') return;
      await trips.update(id, { sync_state: 'failed', sync_error: code }, at);
    } catch (error) {
      report(error, `mark trip failed for item ${item.id}`);
    }
  }

  async function pass(at: number): Promise<DrainResult> {
    const result: DrainResult = { done: 0, failed: 0, deferred: 0 };
    let items: QueueItem[];
    try {
      // Hand back claims a killed process left standing before deciding what is due. `nextDue`
      // repeats this inside its own claim transaction; doing it here first means a stale claim is
      // released even when this pass then finds nothing else to do.
      await queue.reclaimInflight(RECLAIM_AFTER_S, at);
      items = await queue.nextDue(at, batchSize);
    } catch (error) {
      if (isDatabaseLocked(error)) return result;
      throw error;
    }

    for (const item of items) {
      // The engine may have started a drive between two items.
      if (isRecording()) {
        await queue.release(item.id, at);
        result.deferred += 1;
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await runItem(item, at);
      } catch (error) {
        if (isDatabaseLocked(error)) {
          await queue.release(item.id, at).catch((e: unknown) => report(e, 'release'));
          result.deferred += 1;
          // The recorder holds the write lock. Everything after this would meet it too.
          break;
        }
        report(error, `item ${item.id}`);
        outcome = { kind: 'retry', code: 'unexpected' };
      }
      await settle(item, outcome, at, result);
    }
    return result;
  }

  async function drainOnce(at: number = now()): Promise<DrainResult> {
    const empty: DrainResult = { done: 0, failed: 0, deferred: 0 };
    // One drain at a time: two passes claiming the same items would race on every `markAttempt`.
    if (draining || isRecording()) return empty;
    draining = true;
    try {
      return await pass(at);
    } finally {
      draining = false;
    }
  }

  function clearRecordingRetry(): void {
    if (recordingRetry === null) return;
    clearTimeout(recordingRetry);
    recordingRetry = null;
  }

  function wake(): void {
    if (!started || draining) return;
    if (isRecording()) {
      // The wake would otherwise be lost: nothing tells the runner when a drive ends, and the
      // app is already in the foreground, so no AppState change is coming either.
      if (recordingRetry === null) {
        recordingRetry = setTimeout(() => {
          recordingRetry = null;
          wake();
        }, RECORDING_RETRY_MS);
      }
      return;
    }
    clearRecordingRetry();
    void drainOnce(now()).catch((error: unknown) => report(error, 'drain'));
  }

  return {
    drainOnce,

    start(): void {
      if (started) return;
      started = true;
      unsubscribes.push(onQueueChanged(wake));
      if (deps.appState) {
        const subscription = deps.appState.addEventListener('change', (state) => {
          if (state === 'active') wake();
        });
        unsubscribes.push(() => subscription.remove());
      }
      // Whatever is already queued goes now, rather than at the next foreground.
      wake();
    },

    stop(): void {
      started = false;
      clearRecordingRetry();
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    },
  };
}
