/**
 * The three `trip-actions` calls the device owes the server (§4.5, §7.D D3/D5): a disputed event,
 * a role correction, and a deleted trip.
 *
 * Each one is written to SQLite first and queued; this module is the other half — what the runner
 * does when the item comes due. The shape is deliberately the same as `finalize-trip`'s:
 *
 * 1. parse the stored payload against the contract (drift is terminal — retrying sends the same
 *    bytes and gets the same refusal);
 * 2. `POST functions/v1/trip-actions` with the body **verbatim**, exactly as it was queued;
 * 3. parse the reply strictly and apply it in one transaction — the trip's score and status, the
 *    event's status, the driver's own record of the report, and every `DayRow` the server sent
 *    into the day cache, so the home screen's badges are right offline;
 * 4. classify anything that went wrong the way the server's contract says to.
 *
 * Rules worth stating out loud, because they are easy to get wrong:
 *
 * - **The client never computes an allowance.** §9.9's guard-rails (3 per 7 days, 20 % per 30
 *   days, a free "wrong limit" with a stated posted limit) live on the server. `autoAccepted`,
 *   `remainingAllowance` and `reason` are read from the reply and stored; nothing here counts.
 * - **A reply this build cannot read in full is not applied.** Like `applyFinalize`, a parse
 *   failure is *retryable*: the call succeeded, so failing the item would be wrong, and writing
 *   half an answer would be worse.
 * - **`days` is authoritative and always present.** Every 200 carries the rows the server
 *   recomputed (or the stored row when it recomputed nothing), so the cache is upserted on every
 *   outcome — including a denied dispute and a replay.
 * - **A 409 is terminal here, unlike `finalize-trip`.** `classifyStatus` treats 409 as retryable
 *   because finalize-trip answers 409 when it wants the trace re-sent. `trip-actions` answers 409
 *   only for `ambiguous_event` and `trip_deleted`, neither of which a retry can fix.
 * - **The queue kind is not the wire action.** `delete-trip` is the kind; `delete` is the action
 *   in the body.
 */
import { z } from 'zod';

import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createTripsRepo } from '@/data/db/trips';
import {
  DISPUTE_REASONS,
  type DisputeOutcome,
  type DisputeRecord,
  type EventPatch,
  type TripPatch,
  type TripStatus,
} from '@/data/db/types';
import type { SyncKind } from '@/data/sync/kinds';
import { CLIENT_TRIP_ID } from '@/data/sync/queue';
import { classifyInvokeError, DayRowSchema, type DayRow, type Failure } from '@/data/sync/response';

/** The edge function all three actions post to. */
export const TRIP_ACTIONS_FUNCTION = 'trip-actions';

/** The three queue kinds this module handles. */
export const ACTION_KINDS = ['dispute', 'set-role', 'delete-trip'] as const satisfies readonly SyncKind[];
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * What one item's attempt concluded, shared with the runner so a handler can live outside it.
 * `defer` hands the claim back without counting an attempt — the work was never tried.
 */
export type ActionOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; code: string }
  | { kind: 'retry'; code: string; retryAfterS?: number | null }
  | { kind: 'unauthorized'; code: string }
  | { kind: 'defer'; until?: number };

/**
 * The slice of `@supabase/supabase-js` an action needs. Structural, so the runner's `SyncSupabase`
 * is assignable and a test double needs exactly one method.
 */
export interface ActionsSupabase {
  functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> }
    ): Promise<{ data: unknown; error: unknown }>;
  };
}

export interface ActionContext {
  db: Db;
  supabase: ActionsSupabase;
  /** The pass's clock: what the reply is stamped with. */
  now: number;
  /** Told about a reply this build could not read, and anything else worth a support log. */
  report?: (error: unknown, context: string) => void;
}

export type ActionHandler = (payloadJson: string, ctx: ActionContext) => Promise<ActionOutcome>;

// ---------------------------------------------------------------------------------------------
// Request contracts — the bodies Task 2b's function reads, restated so a queued item is validated
// before it is sent and drift cannot reach the wire.
// ---------------------------------------------------------------------------------------------

/** `trip_events.client_event_id` is length-bounded on the server, as the table is. */
const CLIENT_EVENT_ID = z.string().min(1).max(64);

export const DisputePayloadSchema = z
  .object({
    action: z.literal('dispute'),
    clientEventId: CLIENT_EVENT_ID,
    reason: z.enum(DISPUTE_REASONS),
    /** The server strips control and format characters, so a stored note may come back shorter. */
    note: z.string().max(500).nullable().optional(),
    statedLimitMph: z.number().int().min(5).max(100).nullable().optional(),
  })
  .strict();

export const SetRolePayloadSchema = z
  .object({
    action: z.literal('set-role'),
    clientTripId: z.string().regex(CLIENT_TRIP_ID),
    role: z.enum(['driver', 'passenger', 'other']),
  })
  .strict();

export const DeleteTripPayloadSchema = z
  .object({
    action: z.literal('delete'),
    clientTripId: z.string().regex(CLIENT_TRIP_ID),
  })
  .strict();

export type DisputePayload = z.infer<typeof DisputePayloadSchema>;
export type SetRolePayload = z.infer<typeof SetRolePayloadSchema>;
export type DeleteTripPayload = z.infer<typeof DeleteTripPayloadSchema>;

// ---------------------------------------------------------------------------------------------
// Response contracts — strict, for the same reason `FinalizeResponseSchema` is.
// ---------------------------------------------------------------------------------------------

/** The statuses a server re-score may settle a trip at — every local one but `recording`. */
const SERVER_TRIP_STATUSES = [
  'provisional',
  'final',
  'unscored',
  'discarded',
] as const satisfies readonly TripStatus[];

const ServerStatus = z.enum(SERVER_TRIP_STATUSES);
const ServerScore = z.number().int().min(0).max(100).nullable();
/** One row per day the action moved: the trip's own, plus today when the action lands later. */
const Days = z.array(DayRowSchema).min(1);

export const DisputeResponseSchema = z
  .object({
    tripId: z.uuid(),
    score: ServerScore,
    status: ServerStatus,
    /** Inside §9.9's guard-rails: the event is removed from the score and the trip re-scored. */
    autoAccepted: z.boolean(),
    /** Reports left inside the guard-rails, as the server counted them. Never derived here. */
    remainingAllowance: z.number().int().nonnegative(),
    /** The writer's `denied_reason` (`allowance_7d` / `allowance_30d`), null when accepted. */
    reason: z.string().min(1).max(64).nullable(),
    /** The trip still holds a severe speeding episode after the report was applied. */
    hadSevereEvent: z.boolean(),
    days: Days,
    replayed: z.boolean(),
  })
  .strict();

export const SetRoleResponseSchema = z
  .object({
    tripId: z.uuid(),
    role: z.enum(['driver', 'passenger', 'other']),
    score: ServerScore,
    status: ServerStatus,
    days: Days,
    replayed: z.boolean(),
  })
  .strict();

export const DeleteTripResponseSchema = z
  .object({
    tripId: z.uuid(),
    deleted: z.literal(true),
    days: Days,
    replayed: z.boolean(),
  })
  .strict();

export type DisputeResponse = z.infer<typeof DisputeResponseSchema>;
export type SetRoleResponse = z.infer<typeof SetRoleResponseSchema>;
export type DeleteTripResponse = z.infer<typeof DeleteTripResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------------------------

/** `JSON.parse` that answers `null` instead of throwing — a stored row is data, not a promise. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const failureOutcome = (failure: Failure): ActionOutcome =>
  failure.kind === 'terminal'
    ? { kind: 'failed', code: failure.code }
    : failure.kind === 'unauthorized'
      ? { kind: 'unauthorized', code: failure.code }
      : { kind: 'retry', code: failure.code, retryAfterS: failure.retryAfterS };

/**
 * `classifyInvokeError` with the one difference the `trip-actions` contract makes: a 409 is the
 * server deciding against us (`ambiguous_event`, `trip_deleted`), not asking for a re-send, so it
 * is terminal here where it is retryable for `finalize-trip`.
 */
export async function classifyActionError(error: unknown, now: number): Promise<Failure> {
  const failure = await classifyInvokeError(error, now);
  return failure.status === 409 ? { ...failure, kind: 'terminal' } : failure;
}

/** Upsert every day the server recomputed. Runs inside the caller's transaction. */
async function cacheDays(db: Db, tx: Db, days: readonly DayRow[], at: number): Promise<void> {
  const cache = createScoreDailyCacheRepo(db);
  for (const day of days) await cache.put(day.day, day, at, tx);
}

/** Post the body verbatim and hand back either the raw reply or the outcome that ended it. */
async function post(
  ctx: ActionContext,
  body: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; outcome: ActionOutcome }> {
  const { data, error } = await ctx.supabase.functions.invoke(TRIP_ACTIONS_FUNCTION, { body });
  if (error) return { ok: false, outcome: failureOutcome(await classifyActionError(error, ctx.now)) };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------------------------
// dispute (§7.D D3, §9.9)
// ---------------------------------------------------------------------------------------------

/** How the reply's fields become the driver's own record of the report. */
function settleDispute(
  existing: DisputeRecord | null,
  payload: DisputePayload,
  reply: DisputeResponse,
  at: number
): DisputeRecord {
  const outcome: DisputeOutcome = reply.autoAccepted ? 'accepted' : 'denied';
  return {
    reason: existing?.reason ?? payload.reason,
    note: existing?.note ?? payload.note ?? null,
    statedLimitMph: existing?.statedLimitMph ?? payload.statedLimitMph ?? null,
    submittedAt: existing?.submittedAt ?? at,
    outcome,
    deniedReason: reply.reason,
    remainingAllowance: reply.remainingAllowance,
    code: null,
    decidedAt: at,
  };
}

/**
 * Report an event (§7.D D3). The body carries the event's client id only, so the trip it belongs
 * to is read back from the local row — the reply's `tripId` is the *server's* uuid, which is not
 * a key anything on device is filed under.
 *
 * An accepted report removes the event from the score locally too: status `removed`, deduction 0,
 * `corrected` set, which is exactly what the server's re-score just did. A denied one leaves the
 * event scored — it was recorded as feedback, not applied (§9.9) — and says so on the record.
 */
export const runDispute: ActionHandler = async (payloadJson, ctx) => {
  const parsed = DisputePayloadSchema.safeParse(parseJson(payloadJson));
  if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
  const payload = parsed.data;

  const sent = await post(ctx, payload);
  if (!sent.ok) {
    // A refusal is an answer, and D3 has a state for it — "Reports close 14 days after a drive".
    // Without this the item would fail with its code on the queue row and the screen would go on
    // saying "sending" forever, because a terminal outcome never reaches the apply step below.
    if (sent.outcome.kind === 'failed') await recordRefusal(ctx, payload, sent.outcome.code);
    return sent.outcome;
  }

  const reply = DisputeResponseSchema.safeParse(sent.data);
  if (!reply.success) {
    ctx.report?.(reply.error, `trip-actions dispute response for ${payload.clientEventId}`);
    return { kind: 'retry', code: 'invalid_response' };
  }
  const result = reply.data;

  const events = createEventsRepo(ctx.db);
  const trips = createTripsRepo(ctx.db);
  const event = await events.get(payload.clientEventId);

  await ctx.db.transaction(async (tx) => {
    await cacheDays(ctx.db, tx, result.days, ctx.now);
    // The event (and its trip) can be gone: the driver deleted the trip while the report was
    // queued. The day rows above are still the server's latest word and are still worth caching.
    if (event === null) return;

    const existing = parseStoredDispute(event.dispute_json);
    const record = settleDispute(existing, payload, result, ctx.now);
    const patch: EventPatch = { dispute_json: JSON.stringify(record) };
    if (result.autoAccepted) {
      patch.status = 'removed';
      patch.deduction = 0;
      patch.corrected = 1;
    } else if (event.status === 'disputed') {
      // Recorded, not applied: the event goes back to costing what it cost, and the record is
      // what tells D3 it was reported.
      patch.status = 'scored';
    }
    await events.update(event.id, patch, tx);

    const trip = await trips.get(event.client_trip_id, tx);
    if (trip === null) return;
    const conditions = withSevereFlag(trip.conditions_json, result.hadSevereEvent);
    await trips.update(
      event.client_trip_id,
      {
        server_id: result.tripId,
        score: result.score,
        status: result.status,
        sync_state: 'synced',
        sync_error: null,
        conditions_json: conditions,
      } satisfies TripPatch,
      ctx.now,
      tx
    );
  });

  return { kind: 'done' };
};

/** The server's refusal of a report, as §7.D D3 has to show it. */
export const DISPUTE_WINDOW_CLOSED = 'dispute_window_closed';

/**
 * Put a refused report on the event, so D3 can say what happened instead of showing "sending"
 * for a request that will never be sent again. The event's own status is put back the way it was
 * — nothing was applied, so nothing should look as though it was.
 */
async function recordRefusal(
  ctx: ActionContext,
  payload: DisputePayload,
  code: string
): Promise<void> {
  const events = createEventsRepo(ctx.db);
  const event = await events.get(payload.clientEventId);
  if (event === null) return;
  const existing = parseStoredDispute(event.dispute_json);
  const record: DisputeRecord = {
    reason: existing?.reason ?? payload.reason,
    note: existing?.note ?? payload.note ?? null,
    statedLimitMph: existing?.statedLimitMph ?? payload.statedLimitMph ?? null,
    submittedAt: existing?.submittedAt ?? ctx.now,
    outcome: code === DISPUTE_WINDOW_CLOSED ? 'window_closed' : 'refused',
    deniedReason: null,
    remainingAllowance: null,
    code,
    decidedAt: ctx.now,
  };
  const patch: EventPatch = { dispute_json: JSON.stringify(record) };
  if (event.status === 'disputed') patch.status = 'scored';
  await events.update(event.id, patch);
};

/**
 * `conditions_json` with the server's re-derived severe-speeding flag written back (§9.9 fix
 * round). The rest of the object is left exactly as it was: night and precipitation are the
 * device's observations and the server does not restate them.
 */
function withSevereFlag(json: string | null, hadSevereEvent: boolean): string {
  let base: Record<string, unknown> = {};
  if (json !== null) {
    const parsed = parseJson(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>;
    }
  }
  return JSON.stringify({ ...base, hadSevereEvent });
}

/** The stored record, read leniently — this app wrote it, and a field it lacks is a default. */
function parseStoredDispute(json: string | null): DisputeRecord | null {
  if (json === null) return null;
  const raw = parseJson(json);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Partial<DisputeRecord>;
  if (typeof record.reason !== 'string') return null;
  if (!(DISPUTE_REASONS as readonly string[]).includes(record.reason)) return null;
  return {
    reason: record.reason,
    note: typeof record.note === 'string' ? record.note : null,
    statedLimitMph: typeof record.statedLimitMph === 'number' ? record.statedLimitMph : null,
    submittedAt: typeof record.submittedAt === 'number' ? record.submittedAt : 0,
    outcome: 'queued',
    deniedReason: null,
    remainingAllowance: null,
    code: null,
    decidedAt: null,
  };
}

// ---------------------------------------------------------------------------------------------
// set-role (§7.C C10, §7.D D5)
// ---------------------------------------------------------------------------------------------

/**
 * Send the driver's answer to "were you driving?". The server re-scores under the new role and
 * answers with the trip's score and status, which replace whatever the device guessed — a
 * passenger trip comes back `unscored` with no score, a driver's trip with a fresh one.
 */
export const runSetRole: ActionHandler = async (payloadJson, ctx) => {
  const parsed = SetRolePayloadSchema.safeParse(parseJson(payloadJson));
  if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
  const payload = parsed.data;

  const sent = await post(ctx, payload);
  if (!sent.ok) return sent.outcome;

  const reply = SetRoleResponseSchema.safeParse(sent.data);
  if (!reply.success) {
    ctx.report?.(reply.error, `trip-actions set-role response for ${payload.clientTripId}`);
    return { kind: 'retry', code: 'invalid_response' };
  }
  const result = reply.data;

  const trips = createTripsRepo(ctx.db);
  await ctx.db.transaction(async (tx) => {
    await cacheDays(ctx.db, tx, result.days, ctx.now);
    const trip = await trips.get(payload.clientTripId, tx);
    if (trip === null) return;
    await trips.update(
      payload.clientTripId,
      {
        server_id: result.tripId,
        role: result.role,
        score: result.score,
        status: result.status,
        sync_state: 'synced',
        sync_error: null,
      } satisfies TripPatch,
      ctx.now,
      tx
    );
  });

  return { kind: 'done' };
};

// ---------------------------------------------------------------------------------------------
// delete-trip (§7.D D5)
// ---------------------------------------------------------------------------------------------

/**
 * Tell the server the trip is gone. The local row was marked `deleted_at` the moment the driver
 * confirmed, so nothing on screen changes here; what the reply brings is the day rows the delete
 * moved, which the badges on Home are read from.
 *
 * The row is kept, not dropped: `delete-trip` may be retried, a `trace-upload` item may still
 * name the trip (the runner reads `deleted_at` to drop it), and the delete is what the server
 * itself did — a soft delete with the summary and events removed from every aggregate.
 */
export const runDeleteTrip: ActionHandler = async (payloadJson, ctx) => {
  const parsed = DeleteTripPayloadSchema.safeParse(parseJson(payloadJson));
  if (!parsed.success) return { kind: 'failed', code: 'invalid_payload' };
  const payload = parsed.data;

  const sent = await post(ctx, payload);
  if (!sent.ok) return sent.outcome;

  const reply = DeleteTripResponseSchema.safeParse(sent.data);
  if (!reply.success) {
    ctx.report?.(reply.error, `trip-actions delete response for ${payload.clientTripId}`);
    return { kind: 'retry', code: 'invalid_response' };
  }
  const result = reply.data;

  const trips = createTripsRepo(ctx.db);
  await ctx.db.transaction(async (tx) => {
    await cacheDays(ctx.db, tx, result.days, ctx.now);
    const trip = await trips.get(payload.clientTripId, tx);
    if (trip === null) return;
    await trips.update(
      payload.clientTripId,
      { server_id: result.tripId, sync_state: 'synced', sync_error: null } satisfies TripPatch,
      ctx.now,
      tx
    );
  });

  return { kind: 'done' };
};

/** The three handlers, by the queue kind that dispatches to them. */
export const ACTION_HANDLERS: Readonly<Record<ActionKind, ActionHandler>> = {
  dispute: runDispute,
  'set-role': runSetRole,
  'delete-trip': runDeleteTrip,
};

export const isActionKind = (kind: SyncKind): kind is ActionKind =>
  (ACTION_KINDS as readonly SyncKind[]).includes(kind);
