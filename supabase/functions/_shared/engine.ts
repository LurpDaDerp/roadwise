// The drive engine port: the `private.*` SQL functions of migration 0008 (see
// .agent/v3/backend-interface.md), reached over a DIRECT Postgres connection — the `private` schema
// is not exposed by the Data API, so nothing but these functions (and the service role) can call
// them. Every request runs inside ONE transaction: `drive_context` locks the user's progress row,
// the TypeScript scores, `apply_drive` writes; a replay returns the stored response.
//
// Answers are zod-checked against the SQL contract (server-side drift is a 500, never a half-stored
// drive); a writer's refusal is a `PgError` carrying the SQLSTATE and fixed message `pgFailure`
// maps. The handlers never see a query builder or a column name.
import postgres, { type TransactionSql } from 'postgres';
import { z } from 'zod';
import { PgError } from './pg.ts';
import type { DriveBreakdown, DriveEvent } from './scoring/index';

const Uuid = z.uuid();
const Num = z.coerce.number();

/** A stored event as `private.trip_events_json` returns it: a `DriveEvent` plus where and what was measured. */
export const StoredEventSchema = z.object({
  id: Uuid,
  type: z.enum(['speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'phone_handling']),
  tier: z.enum(['minor', 'moderate', 'severe']),
  startedAt: Num,
  durationS: Num,
  units: Num.nullable(),
  stoppedInTraffic: z.boolean().nullable(),
  zone: z.enum(['school', 'construction']).nullable(),
  status: z.enum(['active', 'removed']),
  lat: Num.nullable(),
  lng: Num.nullable(),
  measured: z.record(z.string(), z.unknown()),
  penalty: Num,
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

export const StreakStateSchema = z.object({
  streak: z.number().int().min(0),
  atRisk: z.boolean(),
  freezes: z.number().int().min(0).max(3),
  cleanRun: z.number().int().min(0),
});

export const MergeTargetSchema = z.object({
  tripId: Uuid,
  clientTripId: Uuid,
  /** A refused (spoofed / implausible) drive is never merged into, whatever the SQL answered. */
  reason: z.enum(['too_short', 'spoofed', 'implausible']).nullable(),
  startedAt: Num,
  endedAt: Num,
  tz: z.string(),
  localDay: z.string(),
  miles: Num,
  safeMiles: Num,
  nightMiles: Num,
  durationS: Num,
  polyline: z.string(),
  events: z.array(StoredEventSchema),
  isLoop: z.boolean(),
  loopRepeat: z.boolean(),
  safeMilesEarlierToday: Num,
  streak: StreakStateSchema,
});
export type MergeTarget = z.infer<typeof MergeTargetSchema>;

/** `private.drive_context`: a replay (`existing`) or the context of a fresh drive. */
export const DriveContextSchema = z.union([
  z.object({ existing: z.record(z.string(), z.unknown()) }),
  z.object({
    existing: z.null(),
    week: z.string(),
    leagueEligible: z.boolean(),
    streak: StreakStateSchema,
    safeMilesEarlierToday: Num,
    loopDrivesToday: Num,
    merge: MergeTargetSchema.nullable(),
  }),
]);
export type DriveContext = z.infer<typeof DriveContextSchema>;

/** `private.dispute_context`. */
export const DisputeContextSchema = z.object({
  tripId: Uuid,
  clientTripId: Uuid,
  eventId: Uuid,
  reason: z.enum(['hazard', 'wrong_limit', 'mounted']),
  status: z.enum(['accepted', 'rejected']),
  rejectReason: z.enum(['quota', 'not_mounted']).nullable(),
  scored: z.boolean(),
  oldNet: Num,
  quotaLeft: Num.nullable(),
  rescore: z
    .object({
      input: z.object({
        miles: Num,
        safeMiles: Num,
        loopRepeat: z.boolean(),
        events: z.array(StoredEventSchema),
      }),
      ctx: z.object({ streak: Num, safeMilesEarlierToday: Num }),
    })
    .nullable(),
});
export type DisputeContext = z.infer<typeof DisputeContextSchema>;

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

/** The `private.apply_drive` envelope (backend-interface.md §2.2). */
export interface ApplyDriveEnvelope {
  user: string;
  mergeInto: string | null;
  payload: {
    clientTripId: string;
    startedAt: number;
    endedAt: number;
    tz: string;
    localDay: string;
    miles: number;
    safeMiles: number;
    nightMiles: number;
    durationS: number;
    end: { lat: number; lng: number } | null;
    polyline: string;
    appVersion: string;
  };
  scored: boolean;
  reason: 'too_short' | 'spoofed' | 'implausible' | null;
  net: number;
  breakdown: DriveBreakdown;
  events: (DriveEvent & { lat: number | null; lng: number | null; measured: Record<string, unknown> })[];
  streak: {
    before: { streak: number };
    after: { streak: number; atRisk: boolean; freezes: number; cleanRun: number };
    outcome: string;
    freezeEarned: boolean;
  };
  isLoop: boolean;
  loopRepeat: boolean;
  safeMilesEarlierToday: number;
  scoringVersion: number;
}

/** The `private.apply_dispute` envelope (backend-interface.md §3.2). */
export interface ApplyDisputeEnvelope {
  user: string;
  tripId: string;
  eventId: string;
  reason: 'hazard' | 'wrong_limit' | 'mounted';
  status: 'accepted' | 'rejected';
  rejectReason?: string | null;
  breakdown?: DriveBreakdown;
  net?: number;
}

/** What one transaction may do. Every answer that is a stored document comes back as `unknown`
 * for the handler to check against its own wire contract. */
export interface EngineTx {
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
  driveContext(args: DriveContextArgs): Promise<DriveContext>;
  applyDrive(envelope: ApplyDriveEnvelope): Promise<unknown>;
  revertNotDriving(userId: string, clientTripId: string): Promise<unknown>;
  disputeContext(userId: string, clientTripId: string, eventId: string, reason: 'hazard' | 'wrong_limit' | 'mounted'): Promise<DisputeContext>;
  applyDispute(envelope: ApplyDisputeEnvelope): Promise<unknown>;
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
    revertNotDriving: (userId, clientTripId) =>
      call<unknown>('private.revert_latest_not_driving', () =>
        tx<{ r: unknown }[]>`select private.revert_latest_not_driving(${userId}::uuid, ${clientTripId}::uuid) as r`
      ),
    async disputeContext(userId, clientTripId, eventId, reason) {
      const r = await call<unknown>('private.dispute_context', () =>
        tx<{ r: unknown }[]>`select private.dispute_context(${userId}::uuid, ${clientTripId}::uuid, ${eventId}::uuid, ${reason}) as r`
      );
      const parsed = DisputeContextSchema.safeParse(r);
      if (!parsed.success) throw new EngineContractError('private.dispute_context');
      return parsed.data;
    },
    applyDispute: (envelope) =>
      call<unknown>('private.apply_dispute', () => tx<{ r: unknown }[]>`select private.apply_dispute(${tx.json(envelope as never)}) as r`),
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
