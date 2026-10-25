// The sync runner: the device half of the upload (plan §3, §4, §5).
//
// It drains the `sync_queue` the finalizer and the drive actions fill. A `finalize-trip` item
// posts its payload as v4 (one an older build queued as v3 is upgraded first) and writes the
// server's answer back: the trip becomes `scored` or `unscored` with its result. Once the answer is
// written the drive's samples go. A `trip-actions` item posts a dispute or "wasn't driving" and
// resolves the optimistic `pending` rows.
//
// Rules:
// - **Never while the engine is recording or finalizing**: a drain competes for SQLite's write lock.
// - **Only under the owner's session**: an item carries the uid it was queued for; a session of
//   another user never posts it, and every local write asserts, inside its transaction, that the
//   device still records that owner.
// - **A claim is only ever closed by the pass that holds it.**
// - **Retries** follow the queue's ladder; a terminal refusal fails the item for good and is shown.
//   A server older than the upload (`server_behind`) is a retry, never a refusal.
import { isDashcamType } from '@scoring';

import type { Db } from '@/data/db/driver';
import { createEventsRepo, type EventsRepo } from '@/data/db/events';
import { createQueueRepo, TRANSPORT_FAILURE } from '@/data/db/queue';
import { createSamplesRepo } from '@/data/db/samples';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { EventRow, QueueItem, TripRow, TripStatus } from '@/data/db/types';
import { emitDataChanged, onDataChanged } from '@/data/events';
import { applyServerDrive, readServerDrive } from '@/data/hydrate/restore';
import { countEvents } from '@/data/queries/rows';
import { isSyncKind } from '@/data/sync/kinds';
import { FinalizeTripResponseSchema, parseFinalizeUpload, type FinalizeTripResponse } from '@/data/sync/payload';
import { deviceOwnerIs, finalizeIdempotencyKey, SESSION_UID_KEY, TripActionSchema, type TripAction } from '@/data/sync/queue';
import { classifyInvokeError, DisputeResultSchema, FUNCTION_NOT_FOUND_CODE, isDatabaseLocked, NotDrivingResultSchema, type Failure } from '@/data/sync/response';

export const FINALIZE_FUNCTION = 'finalize-trip';
export const ACTIONS_FUNCTION = 'trip-actions';
/** How long a settled queue item is kept before it is purged (its body is the whole drive). */
export const PURGE_DONE_AFTER_MS = 24 * 60 * 60 * 1000;
/** After a wake declined because the engine was recording, try again this long after. */
export const RECORDING_RETRY_MS = 15_000;
/** An item queued for another user waits this long before it is looked at again. */
export const FOREIGN_OWNER_RETRY_MS = 60 * 60_000;
/** With no session, items wait this long. */
export const NO_SESSION_RETRY_MS = 60_000;
/** While the app is open, the next retry is woken for, at most this far ahead and no sooner than the floor. */
export const RETRY_WAKE_MAX_MS = 60 * 60_000;
export const RETRY_WAKE_MIN_MS = 1_000;
export const DEFAULT_BATCH = 10;
export const MAX_ROUNDS = 20;

/**
 * What `trip-actions` answers an action it already holds: a retry of a "Wasn't driving" or a report
 * whose first answer was lost. Not a refusal: the action went through, so the device keeps what it
 * shows and reads the drive back from the server.
 */
export const ALREADY_APPLIED: ReadonlySet<string> = new Set(['already_marked', 'already_not_driving', 'already_disputed']);

/** The refusals the user can act on; anything else is shown as "couldn't send". */
export const DISPUTE_REFUSALS: Readonly<Record<string, string>> = {
  too_old: 'This drive is too old to report.',
  already_disputed: 'This event was already reported.',
  reason_mismatch: "That reason doesn't apply to this event.",
  not_found: 'This event is no longer on the server.',
};

export interface AppStateLike {
  currentState?: string | null;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/** What the runner uses of the Supabase client. */
export interface SyncSupabase {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error?: unknown }>;
    refreshSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: unknown }>;
  };
  functions: {
    invoke(name: string, options: { body: unknown }): Promise<{ data: unknown; error: unknown }>;
  };
  /** Reads the server's copy of a drive after an action it already holds (`list_my_drives`). */
  rpc?(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface SyncRunnerDeps {
  db: Db;
  supabase: SyncSupabase;
  /** Whether a drain may run now (foreground, or the Android headless task). */
  mayDrain: () => boolean;
  /** The engine is recording or finalizing: no drain. */
  isRecording: () => boolean;
  appState?: AppStateLike;
  now?: () => number;
  batch?: number;
  onError?: (error: unknown, context: string) => void;
}

export interface DrainResult {
  ran: boolean;
  done: number;
  failed: number;
  deferred: number;
}

export interface SyncRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One pass now (if allowed). */
  drainOnce(): Promise<DrainResult>;
  /** Resolves once no pass is running. */
  idle(): Promise<void>;
  /** Items still owed: pending or in flight. */
  owed(): Promise<number>;
  /** The device's owner signed in: what waited only for a session is sent now, not when the app next comes to the front. */
  signedIn(): Promise<void>;
}

type Outcome = { kind: 'done' } | { kind: 'retry'; error: string; untilMs?: number } | { kind: 'refused'; error: string } | { kind: 'release'; untilMs: number };

const noop = (): void => {};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The drive's clean flag from the events it keeps: no active event other than DashPal's; null when unscored. */
const cleanOf = (events: readonly EventRow[], scored: boolean): 0 | 1 | null =>
  scored ? (events.some((e) => e.status === 'active' && !isDashcamType(e.type)) ? 0 : 1) : null;

/**
 * The answer lists every event the server keeps. A local DashPal event it does not list (one the
 * server dropped under the DashPal limits) never reached the drive: it is deleted here, so the
 * summary itemizes what was kept. An event with a report in flight or accepted is left alone.
 * Returns the events that remain.
 */
async function dropUnkept(events: EventsRepo, list: EventRow[], resp: FinalizeTripResponse, tx: Db): Promise<EventRow[]> {
  const kept = new Set(resp.eventIds);
  const remain: EventRow[] = [];
  for (const e of list) {
    if (isDashcamType(e.type) && e.status === 'active' && e.dispute_status === 'none' && !kept.has(e.id)) await events.remove(e.id, tx);
    else remain.push(e);
  }
  return remain;
}

/**
 * Write a finalize response into the local rows, and the drive's samples go. A row that is
 * `recording` is left alone. A drive marked "Wasn't driving" before its upload was answered keeps
 * the mark (no clean flag): the mark's own answer settles it, and a refusal puts back the status
 * this answer records (`undoAction`). A "Wasn't driving" refusal the drive already carries
 * (`sync_error`) is kept, so the summary still explains it. An answer naming a `mergedInto` (only a
 * server older than this build joins drives; a replay of an old answer can still carry one) means
 * the server holds this drive inside another: the local row goes, with its events and samples,
 * rather than stand as a duplicate. Runs on a transaction handle.
 */
export async function applyFinalizeResponse(tx: Db, clientTripId: string, resp: FinalizeTripResponse, now: number): Promise<void> {
  const trips = createTripsRepo(tx);
  const events = createEventsRepo(tx);
  const samples = createSamplesRepo(tx);
  const mine = await trips.get(clientTripId, tx);
  if (mine === null || mine.status === 'recording') return;
  const status: TripStatus = resp.scored ? 'scored' : 'unscored';
  const resultJson = JSON.stringify(resp);

  if (resp.mergedInto !== null) {
    await trips.remove(clientTripId, tx);
    return;
  }

  const listed = await events.listByTrip(clientTripId, tx);
  const own = await dropUnkept(events, listed, resp, tx);
  const marked = mine.status === 'not_driving';
  await trips.update(
    clientTripId,
    {
      ...(own.length !== listed.length ? { counts_json: JSON.stringify(countEvents(own)) } : {}),
      status: marked ? 'not_driving' : status,
      clean: marked ? null : cleanOf(own, resp.scored),
      reason: resp.reason,
      result_json: resultJson,
      server_id: resp.tripId,
      // Only a refused upload's code (`failed`) is cleared by an answer; any other is a "Wasn't driving" refusal.
      sync_error: mine.status === 'failed' ? null : mine.sync_error,
    },
    now,
    tx
  );
  await samples.purgeByTrip(clientTripId, tx);
}

/** Whether the upload answer stored on a drive (`result_json`) scored it; null when there is none. */
function answeredScored(resultJson: string | null): boolean | null {
  if (resultJson === null) return null;
  const parsed = FinalizeTripResponseSchema.safeParse(parseJson(resultJson));
  return parsed.success ? parsed.data.scored : null;
}

/** What `applyDisputeResult` reads of a dispute answer. */
export interface DisputeOutcome {
  status: 'accepted' | 'rejected';
  rejectReason: 'quota' | null;
  /** The drive's clean flag as the server now stores it. */
  clean: boolean;
}

/** A dispute's answer into the event and its drive: an accepted report removes the event, recounts the drive and takes the server's clean flag. */
export async function applyDisputeResult(tx: Db, action: Extract<TripAction, { action: 'dispute' }>, result: DisputeOutcome, now: number): Promise<void> {
  const events = createEventsRepo(tx);
  const trips = createTripsRepo(tx);
  const message = result.status === 'accepted' ? null : result.rejectReason === 'quota' ? 'Weekly report limit reached.' : null;
  await events.update(action.eventId, { dispute_status: result.status, dispute_message: message, ...(result.status === 'accepted' ? { status: 'removed' as const } : {}) }, tx);
  if (result.status !== 'accepted') return;
  const trip = await trips.get(action.clientTripId, tx);
  if (trip === null) return;
  const remaining = await events.listByTrip(action.clientTripId, tx);
  await trips.update(
    action.clientTripId,
    {
      clean: trip.status === 'scored' ? (result.clean ? 1 : 0) : trip.clean,
      counts_json: JSON.stringify(countEvents(remaining)),
    },
    now,
    tx
  );
}

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const { db, supabase } = deps;
  const now = deps.now ?? Date.now;
  const batch = deps.batch ?? DEFAULT_BATCH;
  const queue = createQueueRepo(db);
  const trips = createTripsRepo(db);
  const events = createEventsRepo(db);
  const settings = createSettingsRepo(db);
  const report = (error: unknown, context: string): void => {
    try {
      deps.onError?.(error, context);
    } catch {
      // nobody left to tell
    }
  };

  let started = false;
  let draining: Promise<DrainResult> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wake for the next item in a retry back-off; only while the app is open. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let subscriptions: (() => void)[] = [];

  async function readSession(): Promise<string | null> {
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;
      if (uid !== null) await settings.set(SESSION_UID_KEY, uid).catch(noop);
      return uid;
    } catch (error) {
      report(error, 'sync session');
      return null;
    }
  }

  async function invoke(name: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; failure: Failure }> {
    try {
      const { data, error } = await supabase.functions.invoke(name, { body });
      if (error) return { ok: false, failure: await classifyInvokeError(error, now()) };
      return { ok: true, data };
    } catch (error) {
      return { ok: false, failure: await classifyInvokeError(error, now()) };
    }
  }

  async function fenced(uid: string, write: (tx: Db) => Promise<void>): Promise<boolean> {
    return db.transaction(async (tx) => {
      if (!(await deviceOwnerIs(tx, uid))) return false;
      await write(tx);
      return true;
    });
  }

  async function runFinalize(item: QueueItem, uid: string): Promise<Outcome> {
    // A v3 or v4 item (queued by an older build) is upgraded and goes up as v5.
    const parsed = parseFinalizeUpload(parseJson(item.payload_json));
    if (!parsed.success) return { kind: 'refused', error: 'invalid_payload' };
    const payload = parsed.data;
    const res = await invoke(FINALIZE_FUNCTION, payload);
    if (!res.ok) return failureOutcome(res.failure);
    const response = FinalizeTripResponseSchema.safeParse(res.data);
    if (!response.success) return { kind: 'retry', error: 'bad_response' };
    const written = await fenced(uid, (tx) => applyFinalizeResponse(tx, payload.clientTripId, response.data, now()));
    return written ? { kind: 'done' } : { kind: 'release', untilMs: now() + FOREIGN_OWNER_RETRY_MS };
  }

  async function runAction(item: QueueItem, uid: string): Promise<Outcome> {
    const parsed = TripActionSchema.safeParse(parseJson(item.payload_json));
    if (!parsed.success) return { kind: 'refused', error: 'invalid_payload' };
    const action = parsed.data;
    const body = action.action === 'not_driving' ? { action: 'not_driving', clientTripId: action.clientTripId } : action;
    const res = await invoke(ACTIONS_FUNCTION, body);
    if (!res.ok) {
      if (res.failure.kind === 'terminal' && ALREADY_APPLIED.has(res.failure.code)) return alreadyApplied(uid, action, res.failure.code);
      // The server does not hold the drive yet because its upload is still owed: no refusal. The
      // action waits for the upload, and nothing is undone.
      if (res.failure.kind === 'terminal' && res.failure.code === FUNCTION_NOT_FOUND_CODE && (await queue.owes(finalizeIdempotencyKey(action.clientTripId)))) {
        return { kind: 'retry', error: FUNCTION_NOT_FOUND_CODE };
      }
      if (res.failure.kind === 'terminal') await undoAction(uid, action, res.failure.code);
      return failureOutcome(res.failure);
    }
    if (action.action === 'dispute') {
      const result = DisputeResultSchema.safeParse(res.data);
      if (!result.success) return { kind: 'retry', error: 'bad_response' };
      const written = await fenced(uid, (tx) => applyDisputeResult(tx, action, result.data, now()));
      return written ? { kind: 'done' } : { kind: 'release', untilMs: now() + FOREIGN_OWNER_RETRY_MS };
    }
    const result = NotDrivingResultSchema.safeParse(res.data);
    if (!result.success) return { kind: 'retry', error: 'bad_response' };
    const written = await fenced(uid, async (tx) => {
      await trips.update(action.clientTripId, { status: 'not_driving', clean: null, server_id: result.data.tripId }, now(), tx);
    });
    return written ? { kind: 'done' } : { kind: 'release', untilMs: now() + FOREIGN_OWNER_RETRY_MS };
  }

  /**
   * The server already holds this action (a 409 for a retry whose first answer was lost). Nothing is
   * undone: the drive is read back from the server and its answer written in. "Wasn't driving" is
   * settled either way (the local drive already says so); a report whose outcome cannot be read yet
   * stays pending and is tried again.
   */
  async function alreadyApplied(uid: string, action: TripAction, code: string): Promise<Outcome> {
    let synced = false;
    try {
      synced = await resyncDrive(uid, action);
    } catch (error) {
      report(error, 'sync resync drive');
    }
    if (synced || action.action === 'not_driving') return { kind: 'done' };
    return { kind: 'retry', error: code };
  }

  /** The server's copy of the action's drive, written in (fenced). False when it could not be read. */
  async function resyncDrive(uid: string, action: TripAction): Promise<boolean> {
    const rpc = supabase.rpc?.bind(supabase);
    if (!rpc) return false;
    const trip = await trips.get(action.clientTripId);
    if (trip === null) return false;
    const call = async (fn: string, args?: Record<string, unknown>): Promise<unknown> => {
      const { data, error } = await rpc(fn, args);
      if (error) throw error instanceof Error ? error : new Error(`${fn} failed`);
      return data;
    };
    const server = await readServerDrive(call, action.clientTripId, trip.started_at);
    if (server === null) return false;
    return fenced(uid, async (tx) => {
      await applyServerDrive(tx, server, now());
      if (action.action !== 'dispute') return;
      // The server settles a report at once: one it holds that left the event active was turned down.
      const event = (await events.listByTrip(action.clientTripId, tx)).find((e) => e.id === action.eventId);
      if (event && event.status === 'active' && event.dispute_status === 'pending') {
        await events.update(action.eventId, { dispute_status: 'rejected', dispute_message: null }, tx);
      }
    });
  }

  /**
   * The server refused for good: the optimistic `pending` is resolved to a rejection the user can
   * read. A "Wasn't driving" puts the drive back to the status the server holds: the one its upload
   * answer recorded when that answer came after the tap (a mark made before the upload was
   * answered, whose `previousStatus` is the stale `pending`), else the status it had when tapped.
   */
  async function undoAction(uid: string, action: TripAction, code: string): Promise<void> {
    await fenced(uid, async (tx) => {
      if (action.action === 'dispute') {
        await events.update(action.eventId, { dispute_status: 'rejected', dispute_message: DISPUTE_REFUSALS[code] ?? "Couldn't send this report." }, tx);
        return;
      }
      const trip = await trips.get(action.clientTripId, tx);
      if (trip === null || trip.status !== 'not_driving') return;
      const answered = action.previousStatus === 'pending' && !(await createQueueRepo(tx).owes(finalizeIdempotencyKey(action.clientTripId), tx)) ? answeredScored(trip.result_json) : null;
      // The refusal code (`too_old`, `no_uses_left`, `not_driving_expired`, `not_found`) is what the summary explains.
      if (answered !== null) {
        const clean = cleanOf(await events.listByTrip(action.clientTripId, tx), answered);
        await trips.update(action.clientTripId, { status: answered ? 'scored' : 'unscored', clean, sync_error: code }, now(), tx);
        return;
      }
      const previous = (action.previousStatus ?? 'scored') as TripRow['status'];
      await trips.update(action.clientTripId, { status: previous, sync_error: code }, now(), tx);
    }).catch((error: unknown) => report(error, 'sync undo action'));
  }

  function failureOutcome(failure: Failure): Outcome {
    if (failure.kind === 'terminal') return { kind: 'refused', error: failure.code };
    const untilMs = failure.retryAfterS !== null ? now() + failure.retryAfterS * 1000 : undefined;
    return { kind: 'retry', error: failure.status === null ? TRANSPORT_FAILURE : failure.code, ...(untilMs !== undefined ? { untilMs } : {}) };
  }

  async function settle(item: QueueItem, outcome: Outcome, uid: string): Promise<'done' | 'failed' | 'deferred'> {
    switch (outcome.kind) {
      case 'done':
        await queue.markAttempt(item.id, true, null, now());
        return 'done';
      case 'retry': {
        const after = await queue.markAttempt(item.id, false, outcome.error, now());
        if (after !== null && outcome.untilMs !== undefined) await queue.deferUntil(item.id, outcome.untilMs);
        return after?.status === 'failed' ? 'failed' : 'deferred';
      }
      case 'refused': {
        const after = await queue.markAttempt(item.id, false, outcome.error, now());
        if (after !== null) {
          await queue.markFailed(item.id, outcome.error);
          if (item.kind === 'finalize-trip') {
            const body = parseJson(item.payload_json);
            const id = isRecord(body) && typeof body.clientTripId === 'string' ? body.clientTripId : null;
            if (id !== null) {
              await fenced(uid, async (tx) => {
                await trips.update(id, { status: 'failed', sync_error: outcome.error }, now(), tx);
              }).catch(noop);
            }
          }
        }
        return 'failed';
      }
      case 'release':
        await queue.release(item.id, outcome.untilMs);
        return 'deferred';
    }
  }

  async function pass(): Promise<DrainResult> {
    const result: DrainResult = { ran: true, done: 0, failed: 0, deferred: 0 };
    let refreshed = false;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (!started || !deps.mayDrain() || deps.isRecording()) break;
      let items: QueueItem[];
      try {
        items = await queue.nextDue(now(), batch);
      } catch (error) {
        if (!isDatabaseLocked(error)) report(error, 'sync claim');
        break;
      }
      if (items.length === 0) break;
      const uid = await readSession();
      for (const item of items) {
        if (uid === null) {
          await queue.release(item.id, now() + NO_SESSION_RETRY_MS).catch(noop);
          result.deferred += 1;
          continue;
        }
        if (item.owner_uid !== null && item.owner_uid !== uid) {
          await queue.release(item.id, now() + FOREIGN_OWNER_RETRY_MS).catch(noop);
          result.deferred += 1;
          continue;
        }
        let outcome: Outcome;
        try {
          if (!isSyncKind(item.kind)) outcome = { kind: 'refused', error: 'unknown_kind' };
          else outcome = item.kind === 'finalize-trip' ? await runFinalize(item, uid) : await runAction(item, uid);
          // One token refresh per pass, then the item goes straight back for the next round.
          if (outcome.kind === 'retry' && outcome.error === 'unauthorized' && !refreshed) {
            refreshed = true;
            await supabase.auth.refreshSession().catch(noop);
            await queue.release(item.id, now()).catch(noop);
            result.deferred += 1;
            continue;
          }
        } catch (error) {
          if (isDatabaseLocked(error)) {
            await queue.release(item.id, now() + RECORDING_RETRY_MS).catch(noop);
            result.deferred += 1;
            continue;
          }
          report(error, `sync ${item.kind}`);
          outcome = { kind: 'retry', error: 'exception' };
        }
        try {
          result[await settle(item, outcome, uid)] += 1;
        } catch (error) {
          report(error, 'sync settle');
        }
      }
    }
    if (result.done + result.failed > 0) emitDataChanged({ source: 'sync', result: { done: result.done, failed: result.failed, deferred: result.deferred } });
    return result;
  }

  function drainOnce(): Promise<DrainResult> {
    if (draining) return draining;
    if (!started || !deps.mayDrain() || deps.isRecording()) return Promise.resolve({ ran: false, done: 0, failed: 0, deferred: 0 });
    const run = pass()
      .catch((error: unknown) => {
        report(error, 'sync drain');
        return { ran: true, done: 0, failed: 0, deferred: 0 };
      })
      .finally(() => {
        if (draining === run) draining = null;
      });
    draining = run;
    void run.then(() => armRetry()).catch(noop);
    return run;
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  /**
   * While the app is open, wake for the earliest item still owed, so an upload that failed on a
   * blip (or waits out a Retry-After) goes when it is due rather than at the next foreground. Never
   * in the background, never during a drive (the finalize change event wakes the runner then).
   */
  async function armRetry(): Promise<void> {
    clearRetry();
    if (!started || deps.appState?.currentState !== 'active' || deps.isRecording()) return;
    const at = await queue.nextPendingAt();
    if (at === null || !started) return;
    const delay = Math.min(RETRY_WAKE_MAX_MS, Math.max(RETRY_WAKE_MIN_MS, at - now()));
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      wake();
    }, delay);
  }

  function wake(delayMs = 0): void {
    if (!started || wakeTimer !== null) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      // A drive under way: no polling. The host's `finalize` change event wakes the runner when
      // the drive closes (and the next foreground does too).
      if (deps.isRecording()) return;
      void drainOnce();
    }, delayMs);
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await queue.reopenRetryable(now()).catch((error: unknown) => report(error, 'sync reopen'));
      await queue.purgeDone(now() - PURGE_DONE_AFTER_MS).catch(noop);
      subscriptions.push(
        onDataChanged((change) => {
          if (change.source === 'enqueue' || change.source === 'finalize') wake();
        })
      );
      if (deps.appState) {
        const sub = deps.appState.addEventListener('change', (next) => {
          if (next === 'active') {
            void queue.reopenRetryable(now()).catch(noop);
            wake();
          } else {
            clearRetry();
          }
        });
        subscriptions.push(() => sub.remove());
      }
      wake();
    },
    async stop() {
      started = false;
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      wakeTimer = null;
      clearRetry();
      for (const off of subscriptions) off();
      subscriptions = [];
      await draining?.catch(noop);
    },
    drainOnce,
    idle: async () => {
      await draining?.catch(noop);
    },
    owed: async () => (await queue.countByStatus('pending')) + (await queue.countByStatus('inflight')),
    async signedIn() {
      if (!started) return;
      await queue.makeUntriedDue(now()).catch((error: unknown) => report(error, 'sync signed in'));
      wake();
    },
  };
}
