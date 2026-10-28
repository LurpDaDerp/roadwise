// The drive engine port: the `private.*` SQL functions of migrations 0023, 0026, 0029 and 0031, reached over a DIRECT
// Postgres connection — the `private` schema is not exposed by the Data API, so nothing but these
// functions (and the service role) can call them. Every request runs inside ONE transaction:
// `drive_context` locks the user's progress row and finds a replay, `app_attest_context` reads the
// upload's App Attest key (locked) and `app_attest_advance` moves its counter, `drive_overlaps` finds
// a drive the upload overlaps, the TypeScript decides what is stored, `apply_drive` writes; a replay
// returns the stored response. A "Wasn't driving" and a report are one SQL call each
// (`mark_not_driving`, `dispute_event`).
//
// Answers are zod-checked against the SQL contract (server-side drift is a 500, never a half-stored
// drive); a writer's refusal is a `PgError` carrying the SQLSTATE and fixed message `pgFailure`
// maps. The handlers never see a query builder or a column name.
import postgres, { type TransactionSql } from 'postgres';
import { z } from 'zod';
import type { FinalizeTripPayloadV5, PayloadEvent } from './payload.ts';
import { PgError } from './pg.ts';
import type { Exposure } from './scoring/index';

/** The report reasons the engine decides (`not_driving` is the whole-drive action). */
export type EngineDisputeReason = 'hazard' | 'wrong_limit' | 'camera_wrong' | 'mounted';

/**
 * `private.drive_context`: a replay (`existing`) or null for a fresh drive. `version: 23` is what
 * makes an older database (or older function) fail loudly as a 500, never a 400; so is
 * `phoneUse: true` (0026): a database that cannot store a phone pickup would refuse one with a 400
 * the phone never retries, so this function refuses to run on it. The key is additive, so the
 * function before this one keeps working on a database with 0026. `merge` (the drive an upload
 * could be joined to) is always null, since no start point is passed, and read by nothing: every
 * upload is stored as its own drive.
 */
export const DriveContextSchema = z.object({
  version: z.literal(23),
  phoneUse: z.literal(true),
  existing: z.record(z.string(), z.unknown()).nullable(),
  merge: z.unknown(),
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
}

/**
 * `private.app_attest_context` (0031): the user's App Attest key by the id an upload names (null when
 * the user has no such key, or none was named), and whether the account may post as Android
 * (`androidOnly`: an Android device registered, the account's last iPhone (an iOS registration, an
 * attestation or a verified assertion) none or over 30 days ago, and no App Attest key used in 30 days).
 */
export const AttestContextSchema = z.object({
  key: z
    .object({
      /** The uncompressed P-256 point, hex. */
      publicKey: z.string().regex(/^04[0-9a-f]{128}$/),
      counter: z.number().int().min(0).max(4_294_967_295),
      environment: z.enum(['production', 'development']),
    })
    .nullable(),
  androidOnly: z.boolean(),
});
export type AttestContext = z.infer<typeof AttestContextSchema>;

/** The DashPal seconds of what is stored, with the derived DashPal-drive flag. */
export interface EnvelopeDashcam {
  deviceId: string | null;
  movingS: number;
  coveredS: number;
  synced: boolean;
  /** scoring `dashcamDrive` of these seconds. */
  on: boolean;
}

/** An event as `apply_drive` stores it: the upload's, always active. */
export type EnvelopeEvent = Omit<PayloadEvent, 'zone' | 'status'> & { zone: 'school' | 'construction' | null; status: 'active' };

/** The `private.apply_drive` envelope. */
export interface ApplyDriveEnvelope {
  user: string;
  /** Always null: every upload is stored as its own drive (apply_drive's join branch never runs). */
  mergeInto: string | null;
  /** What the stored drive holds, derived from `payload.dashcam` (the upload's own, as sent). */
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
    /** Always null: apply_drive would keep the end point for the old merge check. */
    end: null;
    polyline: string;
    appVersion: string;
    dashcam: FinalizeTripPayloadV5['dashcam'] | null;
    origin: 'auto' | 'manual';
    notDrivingExpired: boolean;
    /**
     * The upload's own counters (clamped), `phoneS` included; apply_drive estimates them when absent
     * (with no phone seconds).
     */
    exposure: Exposure | null;
  };
  scored: boolean;
  reason: 'too_short' | 'spoofed' | 'implausible' | null;
  /** The stored drive's events: the upload's kept ones. */
  events: EnvelopeEvent[];
  scoringVersion: number;
}

/** What one transaction may do. Every answer that is a stored document comes back as `unknown`
 * for the handler to check against its own wire contract. */
export interface EngineTx {
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
  driveContext(args: DriveContextArgs): Promise<DriveContext>;
  /**
   * `private.drive_overlaps` (0029): whether another stored drive of the user starts more than a
   * minute before this one ends and ends more than a minute after it starts (a replay of this
   * clientTripId is not one), on the times apply_drive will store.
   */
  driveOverlaps(userId: string, clientTripId: string, startedAt: number, endedAt: number): Promise<boolean>;
  /** `private.app_attest_context` (0031): the named key, locked until the transaction ends, and whether the account may post as Android. */
  attestContext(userId: string, keyId: string | null): Promise<AttestContext>;
  /** `private.app_attest_advance` (0031): stores an assertion's counter; false unless it is above the key's. */
  advanceAttestCounter(userId: string, keyId: string, counter: number): Promise<boolean>;
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
    driveOverlaps: (userId, clientTripId, startedAt, endedAt) =>
      call<boolean>('private.drive_overlaps', () =>
        tx<{ r: boolean }[]>`select private.drive_overlaps(${userId}::uuid, ${clientTripId}::uuid, to_timestamp(${startedAt}::double precision / 1000.0),
          to_timestamp(${endedAt}::double precision / 1000.0)) as r`
      ),
    async attestContext(userId, keyId) {
      const r = await call<unknown>('private.app_attest_context', () =>
        tx<{ r: unknown }[]>`select private.app_attest_context(${userId}::uuid, ${keyId}::text) as r`
      );
      const parsed = AttestContextSchema.safeParse(r);
      if (!parsed.success) throw new EngineContractError('private.app_attest_context');
      return parsed.data;
    },
    advanceAttestCounter: (userId, keyId, counter) =>
      call<boolean>('private.app_attest_advance', () =>
        tx<{ r: boolean }[]>`select private.app_attest_advance(${userId}::uuid, ${keyId}::text, ${counter}::bigint) as r`
      ),
    async driveContext(a) {
      // no start point: where a drive started is never passed on (only the old merge check read it)
      const r = await call<unknown>('private.drive_context', () =>
        tx<{ r: unknown }[]>`select private.drive_context(${a.userId}::uuid, ${a.clientTripId}::uuid, to_timestamp(${a.startedAt}::double precision / 1000.0),
          ${a.localDay}::date, null::double precision, null::double precision,
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
