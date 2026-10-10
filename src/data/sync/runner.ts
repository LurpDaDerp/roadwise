// The sync runner: the device half of the upload (plan §3, §4, §5).
//
// It drains the `sync_queue` the finalizer and the drive actions fill. A `finalize-trip` item
// posts its v3 payload verbatim and writes the server's answer back: the trip becomes `scored` or
// `unscored` with its result, or — when the server merged it into the drive before it — the
// earlier local drive becomes the merged union and this one is marked `merged`. A `trip-actions`
// item posts a dispute or "wasn't driving" and resolves the optimistic `pending` rows.
//
// Rules:
// - **Never while the engine is recording or finalizing**: a drain competes for SQLite's write lock.
// - **Only under the owner's session**: an item carries the uid it was queued for; a session of
//   another user never posts it, and every local write asserts, inside its transaction, that the
//   device still records that owner.
// - **A claim is only ever closed by the pass that holds it.**
// - **Retries** follow the queue's ladder; a terminal refusal fails the item for good and is shown.
import type { DriveBreakdown } from '@scoring';

import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { createQueueRepo, TRANSPORT_FAILURE } from '@/data/db/queue';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { QueueItem, TripRow, TripStatus } from '@/data/db/types';
import { emitDataChanged, onDataChanged } from '@/data/events';
import { countEvents } from '@/data/queries/rows';
import { isSyncKind } from '@/data/sync/kinds';
import { FinalizeTripPayloadV3Schema, FinalizeTripResponseV3Schema, type FinalizeTripResponseV3, type DriveBreakdownWire } from '@/data/sync/payload';
import { deviceOwnerIs, SESSION_UID_KEY, TripActionSchema, type TripAction } from '@/data/sync/queue';
import { classifyInvokeError, DisputeResultSchema, isDatabaseLocked, NotDrivingResultSchema, type Failure } from '@/data/sync/response';
import { MAX_POLYLINE_BYTES, MAX_POLYLINE_RUNS } from '@/data/sync/payload';
import { RUN_SEPARATOR, splitRuns } from '@/lib/polyline';

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
export const DEFAULT_BATCH = 10;
export const MAX_ROUNDS = 20;

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

/**
 * The route of a merged drive: every visible run of both drives, in order, still as separate runs.
 * The runs are never connected — a line from the end of one to the start of the next would cross
 * the hidden gap (the trimmed 0.25 mi + the stop + 0.25 mi), an intermediate destination the
 * trimming exists to hide. Over the contract's run or byte cap, the shortest runs go first.
 */
export function joinPolylines(a: string | null, b: string | null, maxBytes = MAX_POLYLINE_BYTES, maxRuns = MAX_POLYLINE_RUNS): string | null {
  let runs = [...splitRuns(a), ...splitRuns(b)];
  const joined = (): string => runs.join(RUN_SEPARATOR);
  while (runs.length > 0 && (runs.length > maxRuns || joined().length > maxBytes)) {
    let shortest = 0;
    runs.forEach((r, i) => {
      if (r.length < (runs[shortest] as string).length) shortest = i;
    });
    runs = runs.filter((_, i) => i !== shortest);
  }
  return runs.length === 0 ? null : joined();
}

const cleanOf = (bd: DriveBreakdown, scored: boolean): 0 | 1 | null => (scored ? (bd.activeEventCount === 0 ? 1 : 0) : null);

/**
 * Write a finalize response into the local rows. With `mergedInto`, the earlier local drive becomes
 * the merged union (metrics summed, events re-parented, the server's result) and this one is
 * hidden as `merged`. Runs on a transaction handle.
 */
export async function applyFinalizeResponse(tx: Db, clientTripId: string, resp: FinalizeTripResponseV3, now: number): Promise<void> {
  const trips = createTripsRepo(tx);
  const events = createEventsRepo(tx);
  const mine = await trips.get(clientTripId, tx);
  if (mine === null) return;
  const status: TripStatus = resp.scored ? 'scored' : 'unscored';
  const penaltyOf = new Map(resp.breakdown.events.map((e) => [e.id, e.penalty]));
  const resultJson = JSON.stringify(resp);

  if (resp.mergedInto !== null) {
    const target = await trips.get(resp.mergedInto, tx);
    if (target !== null && target.client_trip_id !== clientTripId) {
      await events.reparent(clientTripId, target.client_trip_id, tx);
      const all = await events.listByTrip(target.client_trip_id, tx);
      for (const e of all) {
        const penalty = penaltyOf.get(e.id);
        if (penalty !== undefined && penalty !== e.penalty) await events.update(e.id, { penalty }, tx);
      }
      await trips.update(
        target.client_trip_id,
        {
          ended_at: mine.ended_at ?? target.ended_at,
          end_lat: mine.end_lat ?? target.end_lat,
          end_lng: mine.end_lng ?? target.end_lng,
          to_label: mine.to_label ?? target.to_label,
          miles: target.miles + mine.miles,
          safe_miles: target.safe_miles + mine.safe_miles,
          night_miles: target.night_miles + mine.night_miles,
          duration_s: target.duration_s + mine.duration_s,
          max_speed_mph: Math.max(target.max_speed_mph, mine.max_speed_mph),
          polyline: joinPolylines(target.polyline, mine.polyline),
          status,
          points_net: resp.net,
          estimate: 0,
          breakdown_json: JSON.stringify(resp.breakdown),
          clean: cleanOf(resp.breakdown, resp.scored),
          counts_json: JSON.stringify(countEvents(all)),
          reason: resp.reason,
          result_json: resultJson,
          server_id: resp.tripId,
          sync_error: null,
        },
        now,
        tx
      );
    }
    await trips.update(
      clientTripId,
      { status: 'merged', merged_into: resp.mergedInto, points_net: null, estimate: 0, result_json: resultJson, server_id: resp.tripId, sync_error: null },
      now,
      tx
    );
    return;
  }

  for (const e of await events.listByTrip(clientTripId, tx)) {
    const penalty = penaltyOf.get(e.id) ?? null;
    if (penalty !== e.penalty) await events.update(e.id, { penalty }, tx);
  }
  await trips.update(
    clientTripId,
    {
      status,
      points_net: resp.net,
      estimate: 0,
      breakdown_json: JSON.stringify(resp.breakdown),
      clean: cleanOf(resp.breakdown, resp.scored),
      reason: resp.reason,
      result_json: resultJson,
      server_id: resp.tripId,
      sync_error: null,
    },
    now,
    tx
  );
}

/** A dispute's answer into the event and its drive. */
export async function applyDisputeResult(
  tx: Db,
  action: Extract<TripAction, { action: 'dispute' }>,
  result: { status: 'accepted' | 'rejected'; rejectReason: string | null; net: number; breakdown: DriveBreakdownWire | null },
  now: number
): Promise<void> {
  const events = createEventsRepo(tx);
  const trips = createTripsRepo(tx);
  const message = result.status === 'accepted' ? null : result.rejectReason === 'quota' ? 'Weekly report limit reached.' : result.rejectReason === 'not_mounted' ? 'The phone was not mounted for this event.' : null;
  await events.update(action.eventId, { dispute_status: result.status, dispute_message: message, ...(result.status === 'accepted' ? { status: 'removed' as const } : {}) }, tx);
  if (result.status !== 'accepted') return;
  const trip = await trips.get(action.clientTripId, tx);
  if (trip === null) return;
  const remaining = await events.listByTrip(action.clientTripId, tx);
  const activeCount = remaining.filter((e) => e.status === 'active').length;
  // the server re-scored the drive: every remaining event takes its new penalty (repeat indices
  // shift when the removed one was the first of its type), so the itemised list sums to the net
  if (result.breakdown) {
    const penaltyOf = new Map(result.breakdown.events.map((e) => [e.id, e.penalty]));
    for (const e of remaining) {
      const penalty = e.status === 'active' ? (penaltyOf.get(e.id) ?? 0) : 0;
      if (penalty !== e.penalty) await events.update(e.id, { penalty }, tx);
    }
  }
  await trips.update(
    action.clientTripId,
    {
      points_net: result.net,
      estimate: 0,
      clean: trip.status === 'scored' ? (activeCount === 0 ? 1 : 0) : trip.clean,
      counts_json: JSON.stringify(countEvents(remaining)),
      ...(result.breakdown ? { breakdown_json: JSON.stringify(result.breakdown) } : {}),
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
    const parsed = FinalizeTripPayloadV3Schema.safeParse(parseJson(item.payload_json));
    if (!parsed.success) return { kind: 'refused', error: 'invalid_payload' };
    const payload = parsed.data;
    const res = await invoke(FINALIZE_FUNCTION, payload);
    if (!res.ok) return failureOutcome(res.failure);
    const response = FinalizeTripResponseV3Schema.safeParse(res.data);
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
      await trips.update(action.clientTripId, { status: 'not_driving', points_net: 0, estimate: 0, clean: null, server_id: result.data.tripId }, now(), tx);
    });
    return written ? { kind: 'done' } : { kind: 'release', untilMs: now() + FOREIGN_OWNER_RETRY_MS };
  }

  /** The server refused for good: the optimistic `pending` is resolved to a rejection the user can read. */
  async function undoAction(uid: string, action: TripAction, code: string): Promise<void> {
    await fenced(uid, async (tx) => {
      if (action.action === 'dispute') {
        await events.update(action.eventId, { dispute_status: 'rejected', dispute_message: DISPUTE_REFUSALS[code] ?? "Couldn't send this report." }, tx);
        return;
      }
      const previous = (action.previousStatus ?? 'scored') as TripRow['status'];
      const trip = await trips.get(action.clientTripId, tx);
      if (trip === null || trip.status !== 'not_driving') return;
      const points = trip.result_json ? (parseJson(trip.result_json) as { net?: unknown } | undefined)?.net : null;
      await trips.update(action.clientTripId, { status: previous, points_net: typeof points === 'number' ? points : trip.points_net, sync_error: code }, now(), tx);
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
    return run;
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
      for (const off of subscriptions) off();
      subscriptions = [];
      await draining?.catch(noop);
    },
    drainOnce,
    idle: async () => {
      await draining?.catch(noop);
    },
    owed: async () => (await queue.countByStatus('pending')) + (await queue.countByStatus('inflight')),
  };
}
