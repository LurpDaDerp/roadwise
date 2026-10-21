// The drive engine port: the `private.*` SQL functions of migrations 0023 and 0026, reached over a DIRECT
// Postgres connection — the `private` schema is not exposed by the Data API, so nothing but these
// functions (and the service role) can call them. Every request runs inside ONE transaction:
// `drive_context` locks the user's progress row and finds the merge target, the TypeScript decides
// what is stored, `apply_drive` writes; a replay returns the stored response. A "Wasn't driving" and
// a report are one SQL call each (`mark_not_driving`, `dispute_event`).
//
// Answers are zod-checked against the SQL contract (server-side drift is a 500, never a half-stored
// drive); a writer's refusal is a `PgError` carrying the SQLSTATE and fixed message `pgFailure`
// maps. The handlers never see a query builder or a column name.
import postgres, { type TransactionSql } from 'postgres';
import { z } from 'zod';
import { EVENT_TYPES, type FinalizeTripPayloadV5, type PayloadEvent } from './payload.ts';
import { PgError } from './pg.ts';
import type { Exposure } from './scoring/index';

const Uuid = z.uuid();
const Num = z.coerce.number();

/** A stored event as `private.trip_events_json` returns it: a `DriveEvent` plus where and what was measured. */
export const StoredEventSchema = z.object({
  id: Uuid,
  type: z.enum(EVENT_TYPES),
  tier: z.enum(['minor', 'moderate', 'severe']),
  startedAt: Num,
  durationS: Num,
  zone: z.enum(['school', 'construction']).nullable(),
  status: z.enum(['active', 'removed']),
  lat: Num.nullable(),
  lng: Num.nullable(),
  measured: z.record(z.string(), z.unknown()),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

/** A stored drive's DashPal seconds (`trips.dashcam_*`); a drive no dashcam covered holds zeros and no device. */
export const StoredDashcamSchema = z.object({
  deviceId: z.string().nullable(),
  movingS: Num,
  coveredS: Num,
  synced: z.boolean(),
});
export type StoredDashcam = z.infer<typeof StoredDashcamSchema>;

/** The report reasons the engine decides (`not_driving` is the whole-drive action). */
export type EngineDisputeReason = 'hazard' | 'wrong_limit' | 'camera_wrong' | 'mounted';

/** The drive a new upload joins (drive_context's rule: started within 300 s and 150 m of its end). */
export const MergeTargetSchema = z.object({
  tripId: Uuid,
  clientTripId: Uuid,
  /** A refused (spoofed / implausible) drive is never merged into, whatever the SQL answered. */
  reason: z.enum(['too_short', 'spoofed', 'implausible']).nullable(),
  miles: Num,
  durationS: Num,
  events: z.array(StoredEventSchema),
  dashcam: StoredDashcamSchema,
});
export type MergeTarget = z.infer<typeof MergeTargetSchema>;

/**
 * `private.drive_context`: a replay (`existing`) or the merge target of a fresh drive. `version: 23`
 * is what makes an older database (or older function) fail loudly as a 500, never a 400; so is
 * `phoneUse: true` (0026): a database that cannot store a phone pickup would refuse one with a 400
 * the phone never retries, so this function refuses to run on it. The key is additive, so the
 * function before this one keeps working on a database with 0026.
 */
export const DriveContextSchema = z.object({
  version: z.literal(23),
  phoneUse: z.literal(true),
  existing: z.record(z.string(), z.unknown()).nullable(),
  merge: MergeTargetSchema.nullable(),
});
export type DriveContext = z.infer<typeof DriveContextSchema>;

export interface DriveContextArgs {
  userId: string;
  clientTripId: string;
  /** epoch ms */
  startedAt: number;
  endedAt: number;
  /** YYYY-MM-DD, the server's own derivation */
  localDay: string;
  start: { lat: number; lng: number } | null;
}

/** The DashPal seconds of what is stored: the union on a merge, with the derived DashPal-drive flag. */
export interface EnvelopeDashcam {
  deviceId: string | null;
  movingS: number;
  coveredS: number;
  synced: boolean;
  /** scoring `dashcamDrive` of these seconds. */
  on: boolean;
}

/** An event as `apply_drive` stores it: the merge target's (status kept) or the upload's (active). */
export type EnvelopeEvent =
  | StoredEvent
  | (Omit<PayloadEvent, 'zone' | 'status'> & { zone: StoredEvent['zone']; status: 'active' });

/** The `private.apply_drive` envelope. */
export interface ApplyDriveEnvelope {
  user: string;
  mergeInto: string | null;
  /** What the stored (merged) drive holds; `payload.dashcam` is the upload's own, kept on a merged-away row. */
  dashcam: EnvelopeDashcam;
  payload: {
    clientTripId: string;
    startedAt: number;
    endedAt: number;
    tz: string;
    localDay: string;
    miles: number;
    nightMiles: number;
    durationS: number;
    end: { lat: number; lng: number } | null;
    polyline: string;
    appVersion: string;
    dashcam: FinalizeTripPayloadV5['dashcam'] | null;
    origin: 'auto' | 'manual';
    notDrivingExpired: boolean;
    /**
     * The upload's own counters (clamped), `phoneS` included; apply_drive estimates them when absent
     * (with no phone seconds) and sums them on a merge.
     */
    exposure: Exposure | null;
  };
  scored: boolean;
  reason: 'too_short' | 'spoofed' | 'implausible' | null;
  /** The stored drive's events: the merge target's (status kept) then the upload's kept ones. */
  events: EnvelopeEvent[];
  scoringVersion: number;
}

/** What one transaction may do. Every answer that is a stored document comes back as `unknown`
 * for the handler to check against its own wire contract. */
export interface EngineTx {
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
  driveContext(args: DriveContextArgs): Promise<DriveContext>;
  applyDrive(envelope: ApplyDriveEnvelope): Promise<unknown>;
  /** `private.mark_not_driving`: "Wasn't driving" on one drive. */
  markNotDriving(userId: string, clientTripId: string): Promise<unknown>;
  /** `private.dispute_event`: one report, decided and applied. */
  disputeEvent(userId: string, clientTripId: string, eventId: string, reason: EngineDisputeReason): Promise<unknown>;
}

export interface Engine {
  /** Runs `fn` in one transaction; a throw rolls everything back. */
  transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A writer answered with something its contract does not allow. */
export class EngineContractError extends Error {
  constructor(fn: string) {
    super(`${fn} answered outside its contract`);
    this.name = 'EngineContractError';
  }
}

interface PgLikeError {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  hint?: unknown;
}

/** postgres.js raises `PostgresError` with the SQLSTATE in `code`; anything else passes through. */
export function toPgError(err: unknown): unknown {
  const e = err as PgLikeError | null;
  if (e && typeof e === 'object' && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.message === 'string') {
    return new PgError(e.code, e.message, typeof e.detail === 'string' ? e.detail : null, typeof e.hint === 'string' ? e.hint : null);
  }
  return err;
}

type Tx = TransactionSql;

const first = <T>(rows: { r: T }[], fn: string): T => {
  if (rows.length !== 1) throw new EngineContractError(fn);
  return rows[0].r;
};

function txPort(tx: Tx): EngineTx {
  const call = async <T>(fn: string, run: () => Promise<{ r: T }[]>): Promise<T> => {
    try {
      return first(await run(), fn);
    } catch (err) {
      throw toPgError(err);
    }
  };
  return {
    takeRateLimit: (userId, key, window, max) =>
      call<boolean>('private.take_rate_limit', () =>
        tx<{ r: boolean }[]>`select private.take_rate_limit(${userId}::uuid, ${key}, ${window}::interval, ${max}::int) as r`
      ),
    async driveContext(a) {
      const r = await call<unknown>('private.drive_context', () =>
        tx<{ r: unknown }[]>`select private.drive_context(${a.userId}::uuid, ${a.clientTripId}::uuid, to_timestamp(${a.startedAt}::double precision / 1000.0),
          ${a.localDay}::date, ${a.start?.lat ?? null}::double precision, ${a.start?.lng ?? null}::double precision,
          to_timestamp(${a.endedAt}::double precision / 1000.0)) as r`
      );
      const parsed = DriveContextSchema.safeParse(r);
      if (!parsed.success) throw new EngineContractError('private.drive_context');
      return parsed.data;
    },
    applyDrive: (envelope) =>
      call<unknown>('private.apply_drive', () => tx<{ r: unknown }[]>`select private.apply_drive(${tx.json(envelope as never)}) as r`),
    markNotDriving: (userId, clientTripId) =>
      call<unknown>('private.mark_not_driving', () =>
        tx<{ r: unknown }[]>`select private.mark_not_driving(${userId}::uuid, ${clientTripId}::uuid) as r`
      ),
    disputeEvent: (userId, clientTripId, eventId, reason) =>
      call<unknown>('private.dispute_event', () =>
        tx<{ r: unknown }[]>`select private.dispute_event(${userId}::uuid, ${clientTripId}::uuid, ${eventId}::uuid, ${reason}) as r`
      ),
  };
}

/**
 * One small pool per isolate. `prepare: false` so the transaction pooler (port 6543) can serve it;
 * a 5 s lock timeout so a stuck row answers 503 `retry` rather than holding the request.
 */
export function createEngine(dbUrl: string): Engine {
  const sql = postgres(dbUrl, {
    max: 2,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    // milliseconds, as a bare integer setting is read by Postgres
    connection: { lock_timeout: 5000, statement_timeout: 20000 },
  });
  return {
    async transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T> {
      try {
        return (await sql.begin((tx) => fn(txPort(tx)))) as T;
      } catch (err) {
        throw toPgError(err);
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
