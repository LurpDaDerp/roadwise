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
// - **The owner is re-checked after every session read and before every local write** (M2 I-3,
//   carry-over 4). A pass carries the generation it started in (`stop()` moves it) *and* the uid
//   its item was queued under; after each round trip both are asserted again, and a commit also
//   asserts, inside its own transaction, that the device still records that owner. A reply that
//   arrives after the phone changed hands writes nothing, whichever of the three moved first.
//   The one exemption is housekeeping that only ever *removes* — the trace of a drive that is
//   gone — which has to run signed out and cannot put anybody's data anywhere.
// - **A claim is only ever closed by the pass that holds it.** `markAttempt` returns null when
//   another pass has closed it, and the item is then abandoned untouched — no failure recorded,
//   no trip row rewritten.
import type { Db } from '@/data/db/driver';
import { createQueueRepo, RECLAIM_AFTER_S } from '@/data/db/queue';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { QueueItem, TripPatch } from '@/data/db/types';
import {
  ACTION_HANDLERS,
  agePendingDefer,
  isActionKind,
  recordActionGiveUp,
  RETRIES_EXHAUSTED,
  tripFieldsPatch,
  type ActionKind,
  type ActionOutcome,
} from '@/data/sync/actions';
import { isSyncKind, type SyncKind } from '@/data/sync/kinds';
import { FinalizeTripPayloadSchema, type FinalizeTripPayload } from '@/data/sync/payload';
import { emitDataChanged, onDataChanged } from '@/data/events';
import {
  CLIENT_TRIP_ID,
  deviceOwnerIs,
  enqueueTraceUpload,
  SESSION_UID_KEY,
  TraceUploadPayloadSchema,
  type TraceUploadPayload,
} from '@/data/sync/queue';
import {
  classifyInvokeError,
  classifyStorageError,
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
/**
 * How long a settled queue item is kept before it is purged.
 *
 * It is kept at all only so a pass that crashed between the server's answer and the local write
 * can be reasoned about; nothing in the app reads a `done` row. It must not be kept longer,
 * because the body of a `finalize-trip` item is the whole drive — its polyline, both endpoint
 * geohashes and every event coordinate — and leaving that in SQLite for the life of the install
 * would keep a copy of every route the driver has ever taken, deleted or not.
 */
export const PURGE_DONE_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long an item whose kind has no handler yet waits before being looked at again. */
export const UNHANDLED_KIND_RETRY_S = 3600;
/** After a wake declined because the engine was recording, try again this long after. */
export const RECORDING_RETRY_MS = 15_000;
/** Items claimed per batch. */
export const DEFAULT_BATCH = 10;
/** Batches one drain will work through before leaving the rest to the next wake. */
export const MAX_ROUNDS = 20;

/** What the finalizer names a trace file, after the trip's client id. */
export const TRACE_SUFFIX = '.bin.gz';

/** The object key under the traces bucket: the user's own prefix, then the trip. */
export const traceObjectKey = (uid: string, clientTripId: string): string =>
  `${uid}/${clientTripId}${TRACE_SUFFIX}`;

/** What a trace file can be handed to Storage as; the adapter picks whatever the platform uploads best. */
export type TraceBody = Uint8Array | ArrayBuffer | Blob | string;

/** The traces directory, as the finalizer's `writeGzip` counterpart sees it. */
export interface TraceFs {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<TraceBody>;
  /** Remove the local trace. A file that is already gone is not an error. */
  remove(path: string): Promise<void>;
  /**
   * Every file in the traces directory, by name. Optional: an adapter that cannot list simply
   * does not get the orphan sweep, which is housekeeping rather than correctness.
   */
  list?(): Promise<string[]>;
}

export interface NetStatus {
  /** Whether the device is on Wi-Fi right now. Cellular, metered or unknown is `false`. */
  isWifi(): boolean | Promise<boolean>;
}

/**
 * A `NetStatus` that also reports connectivity and its changes (`src/data/net/net.ts`). Declared
 * structurally here so the runner does not import the adapter; `NetAdapter` satisfies it.
 */
export interface NetSubscribable extends NetStatus {
  isOnline(): boolean;
  subscribe(fn: (s: { online: boolean; wifi: boolean }) => void): () => void;
}

const canSubscribe = (net: NetStatus): net is NetSubscribable =>
  typeof (net as Partial<NetSubscribable>).subscribe === 'function' &&
  typeof (net as Partial<NetSubscribable>).isOnline === 'function';

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
  /**
   * The network. A plain `NetStatus` answers only "on Wi-Fi?"; an adapter that can also be
   * subscribed to (`createExpoNet`) adds reconnect recovery: on an offline → online transition the
   * items that gave up only because their retries ran out are reopened and drained (plan D2).
   */
  net: NetStatus | NetSubscribable;
  /**
   * Whether a drain may run now — the host's background policy (plan D2, review I3; H2 supplies
   * it). False: the runner claims nothing and sends nothing, so no attempt is counted and the work
   * waits for the next wake the policy allows (a foreground, or the Android service's lifetime).
   * Checked on every wake and every `drainOnce`. Default: always. `flushDeletes` does not consult
   * it — the driver asked to sign out, in the foreground, and that flush is the last chance.
   */
  mayDrain?: () => boolean;
  /**
   * True while the engine is recording *or finalizing* — the runner stays off the database.
   * Required, not defaulted: a host that forgot it would drain into the 1 Hz recorder in silence.
   */
  isRecording: () => boolean;
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

/** What a sign-out flush achieved: deletes the server confirmed, and deletes still owed. */
export interface FlushResult {
  sent: number;
  /** Pending, in flight or given up: what the sign-out warning must name. */
  left: number;
}

export interface SyncRunner {
  drainOnce(now?: number): Promise<DrainResult>;
  /**
   * Send every delete the device still owes, now, whatever its retry time (security review D1
   * M-1). Called at sign-out while the outgoing session is still valid: once it has gone, and a
   * different driver's sign-in wipes the device, nobody can send them and the next restore would
   * bring those drives back. Waits for a pass in flight first; never runs while recording.
   */
  flushDeletes(now?: number): Promise<FlushResult>;
  /**
   * Resolves once no drain is in flight — including one a finishing drain started for a wake it
   * held. The Android headless task awaits it before its own bounded pass, so it never settles
   * (and lets the service end) in the middle of an upload a finalize already woke (H2 r1 m2).
   */
  idle(): Promise<void>;
  start(): void;
  /**
   * Ends this runner's lifetime. The returned promise settles when a pass already in flight has
   * finished; its writes are refused from the moment `stop()` returns, so awaiting is about not
   * racing the next runtime over the same rows, never about correctness.
   */
  stop(): Promise<void>;
}

/**
 * What one item's attempt concluded. `defer` hands the claim back without counting an attempt —
 * the work was never tried — which is what keeps a trace waiting for Wi-Fi from walking towards
 * `MAX_ATTEMPTS`.
 *
 * Declared in `actions.ts` so the three `trip-actions` handlers can live outside this file and
 * still speak the same language as the two that live in it.
 */
type Outcome = ActionOutcome;

type FailureOutcome = Extract<Outcome, { kind: 'failed' | 'retry' | 'unauthorized' }>;

/** `JSON.parse` that answers `null` instead of throwing — a stored row is data, not a promise. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const failureOutcome = (failure: Failure): FailureOutcome =>
  failure.kind === 'terminal'
    ? { kind: 'failed', code: failure.code }
    : failure.kind === 'unauthorized'
      ? { kind: 'unauthorized', code: failure.code }
      : { kind: 'retry', code: failure.code, retryAfterS: failure.retryAfterS };

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const { db, supabase, fs, net } = deps;
  const now = deps.now ?? Date.now;
  const { isRecording } = deps;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const mayDrain = deps.mayDrain ?? (() => true);
  const report = (error: unknown, context: string): void => deps.onError?.(error, context);

  const queue = createQueueRepo(db);
  const trips = createTripsRepo(db);
  const settings = createSettingsRepo(db);
  const days = createScoreDailyCacheRepo(db);

  let draining = false;
  /** Resolves when the pass in flight finishes, so `stop()` can be awaited. Null when idle. */
  let inFlight: Promise<void> | null = null;
  let started = false;
  /**
   * Which lifetime of this runner a pass belongs to.
   *
   * `stop()` is advisory: it unsubscribes, but a pass already inside `drainOnce` keeps running,
   * and every `await` in it is a window. The host stops this runner when the device changes
   * hands — the database is wiped and rebuilt behind it — so a pass that wrote after that point
   * would put the previous driver's day row into the new driver's empty database, and could post
   * their trip under the new session's token. A pass carries the generation it started in and
   * abandons its claim untouched the moment that number moves.
   */
  let generation = 0;
  const stale = (of: number): boolean => of !== generation;
  /** A wake that arrived while a drain was in flight, to be run when that drain ends. */
  let wakePending = false;
  let recordingRetry: ReturnType<typeof setTimeout> | null = null;
  const unsubscribes: (() => void)[] = [];
  /**
   * The network came back since the last drain: the next drain the host allows reopens the
   * retry-class failures first. A flag rather than an immediate write, because the transition can
   * arrive while a drive is recording (the runner stays off the database) or while the app is
   * armed and idle in the background (no query, no request — design §3.5).
   */
  let reconnectPending = false;
  /** The once-per-lifetime sweep of reports whose drive is gone (security review D2 R1-M1). */
  let sweepPending = false;

  /**
   * The adapter says the device is offline. Only an adapter that reports connectivity can say so;
   * a plain `NetStatus` never does. Offline, a drain claims nothing (review D2 I1): every request
   * would fail at the transport and walk its item down the ladder towards `failed` — attempts that
   * were never really tried — and the reconnect edge brings the drain back.
   */
  const offline = (): boolean => canSubscribe(net) && !net.isOnline();

  /**
   * The signed-in user's id, or null when there is no session to upload under.
   *
   * A new uid is also written to settings, because that is where the enqueue sites read the owner
   * to stamp on work queued between drains. Written only when it changes, so a drain does not
   * cost a write per item.
   */
  let knownUid: string | null = null;
  async function currentUid(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user.id ?? null;
    if (uid !== null && uid !== knownUid) {
      knownUid = uid;
      try {
        await settings.set(SESSION_UID_KEY, uid);
      } catch (error) {
        report(error, 'record session uid');
      }
    }
    return uid;
  }

  /**
   * Whether this item may still be acted on: its pass belongs to the live runner, the session is
   * still the user the item was queued for, AND the device still records that user as its owner.
   * Read fresh — it is the check that follows an await, and the one before every upload.
   *
   * The device-owner half (security review H2 I-1 d): the session can change hands before the
   * device is wiped — a handover whose rebuild has not run yet — and an item that somehow carries
   * the new driver's uid on a device still recorded as the previous driver's must not go up.
   */
  async function ownerHolds(item: QueueItem, of: number): Promise<boolean> {
    if (stale(of) || item.owner_uid === null) return false;
    const uid = await currentUid();
    if (stale(of) || uid !== item.owner_uid) return false;
    return deviceOwnerIs(db, item.owner_uid);
  }

  /** Inside a write's own transaction: the device still records the item's owner. */
  async function ownerStill(tx: Db, item: QueueItem): Promise<boolean> {
    return item.owner_uid !== null && (await deviceOwnerIs(tx, item.owner_uid));
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
    // Anything but a definite yes waits. An adapter that answers `undefined` — a NetInfo state
    // that has not arrived yet — must not be read as "on Wi-Fi, send the megabytes".
    return (await net.isWifi()) !== true;
  }

  /**
   * Whether the trip a queued trace belongs to is gone from the device: deleted outright,
   * `discarded` (§9.4 — a train, a plane; never uploaded in the first place), or soft-deleted.
   *
   * Read through `SELECT *` rather than the trips repo so that `deleted_at` — which Task 7 adds —
   * is honoured the moment the column exists and is simply absent from the row until then.
   */
  async function tripIsGone(clientTripId: string): Promise<boolean> {
    const { rows } = await db.execute('SELECT * FROM trips WHERE client_trip_id = ?', [
      clientTripId,
    ]);
    const row = rows[0];
    if (!row) return true;
    if (row.status === 'discarded') return true;
    return row.deleted_at !== undefined && row.deleted_at !== null;
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

  /**
   * Write the server's answer to the trip and cache its day, in one transaction.
   *
   * A response this build cannot read in full is **not applied**: the upload itself succeeded, so
   * failing the trip would be wrong, and writing half of an answer would be worse. It becomes a
   * retryable `invalid_response`, which a new build or a server correction resolves.
   */
  async function applyFinalize(
    item: QueueItem,
    payload: FinalizeTripPayload,
    response: unknown,
    at: number,
    generation: number
  ): Promise<Outcome> {
    const parsed = FinalizeResponseSchema.safeParse(response);
    if (!parsed.success) {
      report(parsed.error, `finalize-trip response for ${payload.clientTripId}`);
      return { kind: 'retry', code: 'invalid_response' };
    }
    const result = parsed.data;
    // The device may have changed hands while this call was in flight; a wiped database must not
    // be given the previous driver's day row (`days.put` inserts, so it would create one).
    if (!(await ownerHolds(item, generation))) return { kind: 'defer' };

    const applied = await db.transaction(async (tx) => {
      // The last fence, inside the write: the wipe records the new owner in this same table.
      if (!(await ownerStill(tx, item))) return false;
      const stored = await trips.get(payload.clientTripId, tx);
      // A reply that names a different server trip must not re-point this row: every later
      // finalize and trace upload would follow it. The same guard the action handlers carry.
      if (stored !== null && stored.server_id !== null && stored.server_id !== result.tripId) {
        report(
          new Error(`finalize-trip answered a different server trip for ${payload.clientTripId}`),
          'server id mismatch'
        );
        return true;
      }
      await trips.update(
        payload.clientTripId,
        {
          sync_state: 'synced',
          server_id: result.tripId,
          status: result.status,
          score: result.score,
          sync_error: null,
          // The server re-scores from the payload and may disagree — a crash-recovered drive is
          // graded at most B there while the device's own finalizer wrote an A, and the
          // breakdown is what D2's bars, D1's highlight, the tip and every insight rate read.
          ...tripFieldsPatch(result.trip, stored?.conditions_json ?? null),
        } satisfies TripPatch,
        at,
        tx
      );
      // The day row is the server's own §9.9 evaluation over every trip it holds for that date;
      // it is filed under its own `day`, which is the trip's local date, not the device's.
      await days.put(result.day.day, result.day, at, tx);
      return true;
    });
    return applied ? { kind: 'done' } : { kind: 'defer' };
  }

  /** Per-item state that survives the one retry a 401 buys. */
  interface ItemState {
    traceUploadedAt: number | null;
    /** The runner lifetime this item's attempt belongs to; see `generation`. */
    generation: number;
  }

  async function runFinalize(item: QueueItem, state: ItemState, at: number): Promise<Outcome> {
    const parsed = FinalizeTripPayloadSchema.safeParse(parseJson(item.payload_json));
    // Drift between what this build queued and what this build can send. Retrying cannot fix it,
    // and the samples it was built from are long purged.
    if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
    const payload = parsed.data;
    // The id becomes a Storage object key and a local file path. M1's contract bounds its length
    // but not its characters; the server refuses anything outside this set, so refuse it here too.
    if (!CLIENT_TRIP_ID.test(payload.clientTripId)) {
      return { kind: 'failed', code: 'invalid_client_trip_id' };
    }

    // The driver deleted the drive while its upload was still owed. Sending the trace and the
    // summary now would transmit exactly the data they asked to destroy, and the `delete-trip`
    // item that follows is not guaranteed to run after this one (`nextDue` orders by due time).
    if (await tripIsGone(payload.clientTripId)) {
      if (payload.tracePath !== null) await removeTrace(payload.tracePath);
      return { kind: 'done' };
    }

    const uid = await currentUid();
    if (uid === null) return { kind: 'defer' };
    // Re-asserted after the session read, not only before it: `runItem`'s check happened before
    // this round trip, and the object key below comes from whoever is signed in *now*.
    if (stale(state.generation) || item.owner_uid !== uid) return { kind: 'defer' };
    // And the device still records that owner, before anything leaves it (H2 I-1 d).
    if (!(await deviceOwnerIs(db, uid))) return { kind: 'defer' };

    // The summary goes FIRST, and the trace only once the server has accepted the trip (M4 final
    // review backend m2). A trace uploaded ahead of a finalize the server defers (`age_pending`,
    // an account with no age answer yet) sits in Storage with no trips row; after 14 days the
    // orphan purge deletes it, and the later finalize would then name a missing object. It is
    // also the one path that would store a not-yet-aged account's GNSS trace before the answer.
    //
    // The invoke travels under whatever token the client holds *now*, so the fence is checked
    // here: a whole trip posted into the next driver's account must never happen.
    if (!(await ownerHolds(item, state.generation))) return { kind: 'defer' };
    const { data, error } = await supabase.functions.invoke(FINALIZE_FUNCTION, { body: payload });
    if (error) {
      const failure = await classifyInvokeError(error, at);
      // An account with no age answer yet: the drive waits, uncounted, for the birth date (0006)
      return agePendingDefer(failure, at) ?? failureOutcome(failure);
    }

    const applied = await applyFinalize(item, payload, data, at, state.generation);
    if (applied.kind !== 'done') return applied;
    if (payload.tracePath === null) return { kind: 'done' };
    // Uploaded by an earlier build (upload-then-finalize), so this item's own upload licenses it.
    if (state.traceUploadedAt !== null) {
      await removeTrace(payload.tracePath);
      return { kind: 'done' };
    }

    // The trip is accepted: the trace follows. On Wi-Fi (or with the setting off) it goes now;
    // otherwise — or when this attempt fails for any reason — it waits under its own queue item,
    // with that item's own retry and Wi-Fi rules, and the summary is not sent again.
    if (!(await traceWaitsForWifi())) {
      if (!(await ownerHolds(item, state.generation))) return { kind: 'defer' };
      const upload = await uploadTrace(uid, payload.clientTripId, payload.tracePath);
      if (upload.kind === 'ok') {
        // Uploaded (or the file is gone): nothing left for the device to keep.
        if (upload.uploaded) await removeTrace(payload.tracePath);
        return { kind: 'done' };
      }
    }
    // The new item carries *this* item's owner, and is written only while the device still
    // records that owner (security review D1 M-3): a handover between the checks above and this
    // write must not stamp the previous driver's trace with the next driver's uid.
    const owner = item.owner_uid as string;
    const trace = { clientTripId: payload.clientTripId, tracePath: payload.tracePath };
    await db.transaction(async (tx) => {
      if (!(await ownerStill(tx, item))) return false;
      await enqueueTraceUpload(db, trace, at, tx, owner);
      return true;
    });
    // Not queued (the device changed hands): the next driver's wipe removes the file; the trip
    // itself was accepted, so this item is done either way.
    return { kind: 'done' };
  }

  async function runTraceUpload(
    item: QueueItem,
    state: ItemState,
    at: number
  ): Promise<Outcome> {
    const parsed = TraceUploadPayloadSchema.safeParse(parseJson(item.payload_json));
    if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
    const payload: TraceUploadPayload = parsed.data;

    // The trip went away while its trace was waiting for Wi-Fi. Uploading now would put an object
    // under a key nothing will ever read — and, after a delete, one the server has already swept.
    // Checked before the session and the network, so a signed-out device on cellular clears it too.
    if (await tripIsGone(payload.clientTripId)) {
      await removeTrace(payload.tracePath);
      return { kind: 'done' };
    }

    const uid = await currentUid();
    if (uid === null) return { kind: 'defer' };
    if (stale(state.generation) || item.owner_uid !== uid) return { kind: 'defer' };
    if (!(await deviceOwnerIs(db, uid))) return { kind: 'defer' };
    // Waiting for Wi-Fi is not a failed attempt: it must not walk the item towards MAX_ATTEMPTS.
    if (await traceWaitsForWifi()) return { kind: 'defer', until: at + WIFI_RETRY_S * 1000 };

    if (state.traceUploadedAt === null) {
      const upload = await uploadTrace(uid, payload.clientTripId, payload.tracePath);
      if (upload.kind !== 'ok') return upload;
      if (upload.uploaded) {
        if (!(await ownerHolds(item, state.generation))) return { kind: 'defer' };
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
    // `dispute`, `set-role` and `delete-trip` go through `trip-actions` (§4.5). They carry no
    // object and no per-item state, so each is handed its stored body and the pass's clock and
    // nothing else; everything they write back is in `actions.ts`.
    if (isActionKind(kind)) {
      const handler = ACTION_HANDLERS[kind];
      return (item, state, at) =>
        handler(item.payload_json, {
          db,
          supabase,
          now: at,
          report,
          stale: () => stale(state.generation),
          ownerHolds: () => ownerHolds(item, state.generation),
          owner: item.owner_uid,
        });
    }
    return null;
  }

  /** One item, with the single session refresh a 401 is allowed to buy. */
  async function runItem(item: QueueItem, at: number, generation: number): Promise<Outcome> {
    if (!isSyncKind(item.kind)) {
      report(new Error(`unknown queue kind ${item.kind}`), `item ${item.id}`);
      return { kind: 'defer', until: at + UNHANDLED_KIND_RETRY_S * 1000 };
    }
    const handler = handlerFor(item.kind);
    if (!handler) return { kind: 'defer', until: at + UNHANDLED_KIND_RETRY_S * 1000 };

    // Whose work this is. One device holds one database, so an item that is not this session's
    // must never be sent: it would put that driver's own words — a dispute carries free text —
    // into another account's request, and burn an attempt doing it.
    //
    // **Work this build cannot attribute is refused too.** A database created before `owner_uid`
    // existed reads null for every item; sending those under whoever happens to be signed in is
    // precisely the case the column exists to stop, and a null is indistinguishable from it.
    // Everything this build queues carries an owner (`currentOwnerUid` falls back to the
    // bootstrap's own record of the device's user), so a null here means work from before the
    // guard, and refusing it is the point.
    const uid = await currentUid();
    if (uid !== null && item.owner_uid !== uid) {
      return { kind: 'failed', code: item.owner_uid === null ? 'unowned' : 'wrong_account' };
    }
    // Signed out, an action would post the body, be refused 401, spend the one refresh the loop
    // below allows and count an attempt. It is work that was never tried: hand the claim back.
    // (`finalize-trip` and `trace-upload` do their own deferring, after the housekeeping that has
    // to run signed out — dropping the trace of a drive that is gone.)
    if (uid === null && isActionKind(item.kind)) return { kind: 'defer' };
    // Every kind, before any post (H2 R1-M2): the device must still record the item's owner. The
    // session can change hands before the device is wiped, and a dispute's free text, a role
    // answer or a delete must no more go into another account than a trip may. Deferred, not
    // failed: the rebuild's wipe settles it.
    if (uid !== null && !(await deviceOwnerIs(db, uid))) return { kind: 'defer' };

    const state: ItemState = { traceUploadedAt: item.trace_uploaded_at, generation };
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
        await recordGiveUp(item, outcome.code, at);
        result.failed += 1;
        return;
      }
      case 'retry':
      case 'unauthorized': {
        const closed = await queue.markAttempt(item.id, false, outcome.code, at);
        // The ladder ran out: `markAttempt` has just given up on the item, so the trip must stop
        // saying `queued` behind a dead queue row. The item keeps the last transport code as its
        // `last_error`; the trip records *why it will never go*, which is a different fact.
        if (closed?.status === 'failed') {
          await recordGiveUp(item, RETRIES_EXHAUSTED, at);
          result.failed += 1;
          return;
        }
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

  /**
   * Leave the driver something to read when an item gives up, whatever kind it was.
   *
   * The queue row is not that something: nothing in the app renders it, and a settled row is
   * purged within a day. A report that never left has to stop saying "sending", and a delete
   * that never reached the server has to stop looking like it did.
   */
  async function recordGiveUp(item: QueueItem, code: string, at: number): Promise<void> {
    try {
      if (item.kind === 'finalize-trip') {
        await failTrip(item, code, at);
        return;
      }
      if (isSyncKind(item.kind) && isActionKind(item.kind)) {
        await recordActionGiveUp(
          { db, supabase, now: at, report },
          item.kind as ActionKind,
          item.payload_json,
          code
        );
      }
    } catch (error) {
      report(error, `record give-up for item ${item.id}`);
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

  /** Hand a claim back, reporting rather than throwing — used where the database is already sore. */
  async function releaseQuietly(id: number, at: number): Promise<void> {
    try {
      await queue.release(id, at);
    } catch (error) {
      report(error, `release ${id}`);
    }
  }

  interface Round extends DrainResult {
    /** How many items this round claimed; a full batch means there may be more behind them. */
    claimed: number;
    /** The round ended early — the recorder holds the write lock, or a drive started. */
    stopped: boolean;
  }

  /** Claim one batch — of every kind, or only `kind`, due or not — and work it. */
  async function claimAndRun(at: number, generation: number, kind?: SyncKind): Promise<Round> {
    const round: Round = { done: 0, failed: 0, deferred: 0, claimed: 0, stopped: false };
    let items: QueueItem[];
    try {
      // Hand back claims a killed process left standing before deciding what is due. `nextDue`
      // repeats this inside its own claim transaction; doing it here first means a stale claim is
      // released even when this pass then finds nothing else to do.
      await queue.reclaimInflight(RECLAIM_AFTER_S, at);
      items =
        kind === undefined
          ? await queue.nextDue(at, batchSize)
          : await queue.nextDueOfKind(kind, at, batchSize);
    } catch (error) {
      if (isDatabaseLocked(error)) return { ...round, stopped: true };
      throw error;
    }
    round.claimed = items.length;

    for (const item of items) {
      // The engine may have started a drive between two items.
      if (isRecording()) {
        await releaseQuietly(item.id, at);
        round.deferred += 1;
        continue;
      }

      let outcome: Outcome;
      try {
        outcome = await runItem(item, at, generation);
      } catch (error) {
        if (isDatabaseLocked(error)) {
          await releaseQuietly(item.id, at);
          round.deferred += 1;
          // The recorder holds the write lock. Everything after this would meet it too.
          return { ...round, stopped: true };
        }
        report(error, `item ${item.id}`);
        outcome = { kind: 'retry', code: 'unexpected' };
      }

      // The device changed hands while this item was in flight: the claim belongs to a database
      // that no longer exists. Abandon it untouched, exactly as a claim another pass has closed.
      if (stale(generation)) return { ...round, stopped: true };

      // Settling is itself a write, and it can meet the same lock. Failing here leaves the claim
      // standing until `reclaimInflight`, so hand it back and stop rather than push on.
      try {
        await settle(item, outcome, at, round);
      } catch (error) {
        report(error, `settle ${item.id}`);
        await releaseQuietly(item.id, at);
        round.deferred += 1;
        return { ...round, stopped: true };
      }
    }
    return round;
  }

  /**
   * Remove settled items older than `PURGE_DONE_AFTER_MS`.
   *
   * Housekeeping, but privacy housekeeping: a `finalize-trip` body carries the drive's polyline
   * and every event's coordinates, so a `done` row that is never removed is a second copy of the
   * route, outliving even a deleted drive. The cost of purging is that a re-finalize of a trip
   * whose item has gone finds nothing to replay and throws instead — a state M1 already
   * anticipates, and the right trade against keeping the route for ever.
   */
  async function purgeSettled(at: number): Promise<void> {
    try {
      await queue.purgeDone(at - PURGE_DONE_AFTER_MS);
    } catch (error) {
      report(error, 'purge settled queue items');
    }
  }

  /**
   * Delete trace files with no drive behind them.
   *
   * `deleteTrip` writes the rows first and removes the file second, so a process killed between
   * the two leaves the most identifying artefact the app holds on disk with nothing pointing at
   * it. Reordering would be worse — a file removed before a transaction that then failed would
   * lose a trace of a drive that still exists — so the window is closed from the other end
   * instead: anything in the traces directory whose trip is gone is removed here.
   */
  async function sweepOrphanTraces(): Promise<void> {
    if (!fs.list) return;
    try {
      const names = await fs.list();
      for (const name of names) {
        const clientTripId = name.endsWith(TRACE_SUFFIX)
          ? name.slice(0, -TRACE_SUFFIX.length)
          : null;
        if (clientTripId === null || !CLIENT_TRIP_ID.test(clientTripId)) continue;
        const { rows } = await db.execute('SELECT 1 FROM trips WHERE client_trip_id = ?', [
          clientTripId,
        ]);
        if (rows.length === 0) await removeTrace(name);
      }
    } catch (error) {
      report(error, 'sweep orphan traces');
    }
  }

  /**
   * One drain: batches until the backlog is gone.
   *
   * A device that was offline for a week has more than `batchSize` trips waiting, and there is no
   * poll to pick up the rest — the next wake is a foreground or another enqueue. So a round that
   * filled its batch *and* settled something goes round again; progress is guaranteed because a
   * settled item leaves the pending set. A round that only deferred never loops: `release` makes
   * those items due immediately, and looping on them would spin.
   */
  async function pass(at: number, kind?: SyncKind): Promise<DrainResult> {
    const mine = generation;
    const total: DrainResult = { done: 0, failed: 0, deferred: 0 };
    // Once per pass, whether or not there is work: this is what teaches the enqueue sites whose
    // device they are queueing on, and a pass with an empty queue is the common case at launch.
    try {
      await currentUid();
    } catch (error) {
      report(error, 'read session');
    }
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const worked = await claimAndRun(at, mine, kind);
      total.done += worked.done;
      total.failed += worked.failed;
      total.deferred += worked.deferred;
      if (worked.stopped || worked.claimed < batchSize || worked.done + worked.failed === 0) break;
    }
    // Nothing below belongs to a device that has changed hands under this pass.
    if (stale(mine)) return total;

    // Settled work is not kept: see `PURGE_DONE_AFTER_MS`. Both sweeps run on every pass, so a
    // device that never settles anything still tidies up after a delete that was interrupted.
    await purgeSettled(at);
    await sweepOrphanTraces();

    // Trips have changed state and a day row may have landed: tell whoever is showing them. One
    // event, carrying the counts, and only for a pass that settled something. The runner's own
    // listener ignores `sync`, so this no longer costs an empty self-wake.
    if (total.done + total.failed > 0) {
      emitDataChanged({ source: 'sync', result: { ...total } }, (error) =>
        report(error, 'data change listener')
      );
    }
    return total;
  }

  async function drainOnce(at: number = now()): Promise<DrainResult> {
    const empty: DrainResult = { done: 0, failed: 0, deferred: 0 };
    // One drain at a time: two passes claiming the same items would race on every `markAttempt`.
    // And none the host's policy forbids: nothing claimed means no attempt counted.
    if (draining || isRecording() || !mayDrain() || offline()) return empty;
    draining = true;
    // Held so `stop()` can be awaited: the generation fence already refuses a dead pass's writes,
    // but a host rebuilding the runtime (a handover) wants the old pass's network work finished
    // before the new one starts claiming the same rows.
    let settled: () => void = () => {};
    inFlight = new Promise<void>((resolve) => {
      settled = resolve;
    });
    try {
      if (sweepPending) {
        sweepPending = false;
        try {
          await queue.sweepOrphanedReports();
        } catch (error) {
          sweepPending = true;
          report(error, 'sweep orphaned reports');
        }
      }
      if (reconnectPending) {
        reconnectPending = false;
        try {
          await queue.reopenRetryable(at);
        } catch (error) {
          // Kept for the next drain; this one still sends whatever is already due.
          reconnectPending = true;
          report(error, 'reopen retryable items');
        }
      }
      return await pass(at);
    } finally {
      draining = false;
      inFlight = null;
      settled();
      // A wake that arrived mid-drain was not lost, it was held: run it now. The common case is
      // app start, where M1's crash recovery finalizes the interrupted trip (and enqueues, inside
      // its transaction) while `start()`'s own first drain is still running.
      if (wakePending) {
        wakePending = false;
        wake();
      }
    }
  }

  async function flushDeletes(at: number = now()): Promise<FlushResult> {
    // One pass at a time: wait out any in flight, then hold the lock ourselves.
    while (inFlight !== null) await inFlight;
    let sent = 0;
    if (!isRecording() && !draining) {
      draining = true;
      let settled: () => void = () => {};
      inFlight = new Promise<void>((resolve) => {
        settled = resolve;
      });
      try {
        sent = (await pass(at, 'delete-trip')).done;
      } catch (error) {
        report(error, 'flush deletes');
      } finally {
        draining = false;
        inFlight = null;
        settled();
        // A wake held while the flush ran is run now, as `drainOnce` does.
        if (wakePending) {
          wakePending = false;
          wake();
        }
      }
    }
    const { rows } = await db.execute(
      "SELECT COUNT(*) AS n FROM sync_queue WHERE kind = 'delete-trip' AND status IN ('pending', 'inflight', 'failed')"
    );
    return { sent, left: Number(rows[0]?.n ?? 0) };
  }

  function clearRecordingRetry(): void {
    if (recordingRetry === null) return;
    clearTimeout(recordingRetry);
    recordingRetry = null;
  }

  function wake(): void {
    if (!started) return;
    // Before anything else, the recording retry timer included: a drain the policy forbids is not
    // postponed, it is dropped, and the next wake the policy allows (a foreground) picks it up.
    if (!mayDrain()) return;
    // Not dropped: `drainOnce`'s `finally` runs it. `pass()` claims its batch once at the start,
    // so an item enqueued mid-drain is not picked up by the drain that is already running.
    if (draining) {
      wakePending = true;
      return;
    }
    if (isRecording()) {
      // The drive's end normally wakes the runner itself: the host emits a `finalize` change once
      // the snapshot is idle, and that drains at once (and clears this timer; tested). This timer
      // is the safety net for a drive that ends WITHOUT a finalize change — a candidate discarded
      // as "not a drive", a dry run, a finalize that failed — where the wake would otherwise be
      // lost until the next foreground (final review M10d: kept, and why). One timer at most, only
      // while busy; never while armed and idle.
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
    flushDeletes,

    async idle(): Promise<void> {
      while (inFlight) await inFlight;
    },

    start(): void {
      if (started) return;
      started = true;
      // A launch cannot see a network gap it did not witness: items that ran out while this app
      // was killed offline would otherwise stay failed until some later edge (review D2 I1). So the
      // first drain this lifetime allows reopens them, and sweeps orphaned reports, once.
      reconnectPending = true;
      sweepPending = true;
      // New work: something was queued, or the host finalized a drive. A `sync` change is this
      // runner's own pass and a `hydrate` change queues nothing, so neither wakes it.
      unsubscribes.push(
        onDataChanged((change) => {
          if (change.source === 'enqueue' || change.source === 'finalize') wake();
        })
      );
      if (deps.appState) {
        const subscription = deps.appState.addEventListener('change', (state) => {
          if (state === 'active') wake();
        });
        unsubscribes.push(() => subscription.remove());
      }
      // Reconnect recovery: only an offline → online transition counts. A better link while
      // already online (cellular → Wi-Fi) reopens nothing; what waits for Wi-Fi has its own time.
      if (canSubscribe(net)) {
        let online = net.isOnline();
        unsubscribes.push(
          net.subscribe((state) => {
            const reconnected = state.online && !online;
            online = state.online;
            if (!reconnected) return;
            reconnectPending = true;
            wake();
          })
        );
      }
      // Whatever is already queued goes now, rather than at the next foreground.
      wake();
    },

    stop(): Promise<void> {
      // Any pass still in flight belongs to the lifetime that is ending: its writes are refused
      // from here on, whatever it is waiting for. The promise lets a host that is rebuilding the
      // runtime wait for that pass's network work to finish before the new one claims the same rows.
      generation += 1;
      started = false;
      wakePending = false;
      clearRecordingRetry();
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      return inFlight ?? Promise.resolve();
    },
  };
}
