// An in-memory stand-in for the engine port (`engine.ts`): answers each call from a script,
// records every call in order, and rolls back nothing (there is nothing to roll back) — a handler
// test asserts what was asked of the engine and in which order. A scripted drive context is held to
// `DriveContextSchema` as the real port holds the database's answer, so a context from an older
// database (no `version: 23`) is the same contract error.
import {
  AttestContextSchema,
  DriveContextSchema,
  EngineContractError,
  type ApplyDriveEnvelope,
  type AttestContext,
  type DriveContextArgs,
  type Engine,
  type EngineTx,
} from '../engine.ts';

export interface EngineCall {
  fn: keyof EngineTx;
  args: unknown;
}

export interface FakeEngineScript {
  rateLimit?: boolean;
  /** What drive_context answers (checked against `DriveContextSchema`), or the error it throws. */
  context?: unknown;
  /** What drive_overlaps answers (false when left out), or the error it throws. */
  overlaps?: boolean | Error;
  /**
   * What app_attest_context answers (checked against `AttestContextSchema`): no key and no Android
   * device when left out. A function gets the key id the upload named.
   */
  attest?: AttestContext | Error | ((keyId: string | null) => AttestContext);
  /** What app_attest_advance answers (true when left out), or a function of the counter. */
  advance?: boolean | Error | ((counter: number) => boolean);
  apply?: unknown | Error | ((envelope: ApplyDriveEnvelope) => unknown);
  notDriving?: unknown | Error;
  dispute?: unknown | Error | ((args: { userId: string; clientTripId: string; eventId: string; reason: string }) => unknown);
}

export interface FakeEngine {
  engine: Engine;
  calls: EngineCall[];
  /** How many transactions were opened and how many ended in a throw. */
  transactions: { opened: number; failed: number };
}

const answer = <T>(v: T | Error): T => {
  if (v instanceof Error) throw v;
  return v;
};

export function fakeEngine(script: FakeEngineScript = {}): FakeEngine {
  const calls: EngineCall[] = [];
  const transactions = { opened: 0, failed: 0 };
  const tx: EngineTx = {
    takeRateLimit(userId, key, window, max) {
      calls.push({ fn: 'takeRateLimit', args: { userId, key, window, max } });
      return Promise.resolve(script.rateLimit ?? true);
    },
    driveContext(args: DriveContextArgs) {
      calls.push({ fn: 'driveContext', args });
      const raw = answer(script.context ?? new Error('no context scripted'));
      const parsed = DriveContextSchema.safeParse(raw);
      if (!parsed.success) return Promise.reject(new EngineContractError('private.drive_context'));
      return Promise.resolve(parsed.data);
    },
    driveOverlaps(userId, clientTripId, startedAt, endedAt) {
      calls.push({ fn: 'driveOverlaps', args: { userId, clientTripId, startedAt, endedAt } });
      return Promise.resolve(answer(script.overlaps ?? false));
    },
    attestContext(userId, keyId) {
      calls.push({ fn: 'attestContext', args: { userId, keyId } });
      const a = script.attest ?? { key: null, android: false };
      const raw = typeof a === 'function' ? a(keyId) : answer(a);
      const parsed = AttestContextSchema.safeParse(raw);
      if (!parsed.success) return Promise.reject(new EngineContractError('private.app_attest_context'));
      return Promise.resolve(parsed.data);
    },
    advanceAttestCounter(userId, keyId, counter) {
      calls.push({ fn: 'advanceAttestCounter', args: { userId, keyId, counter } });
      const a = script.advance ?? true;
      return Promise.resolve(typeof a === 'function' ? a(counter) : answer(a));
    },
    applyDrive(envelope) {
      calls.push({ fn: 'applyDrive', args: envelope });
      const a = script.apply ?? new Error('no apply scripted');
      return Promise.resolve(typeof a === 'function' ? (a as (e: ApplyDriveEnvelope) => unknown)(envelope) : answer(a));
    },
    markNotDriving(userId, clientTripId) {
      calls.push({ fn: 'markNotDriving', args: { userId, clientTripId } });
      return Promise.resolve(answer(script.notDriving ?? new Error('no not-driving answer scripted')));
    },
    disputeEvent(userId, clientTripId, eventId, reason) {
      const args = { userId, clientTripId, eventId, reason };
      calls.push({ fn: 'disputeEvent', args });
      const a = script.dispute ?? new Error('no dispute answer scripted');
      return Promise.resolve(typeof a === 'function' ? (a as (x: typeof args) => unknown)(args) : answer(a));
    },
  };
  const engine: Engine = {
    async transaction(fn) {
      transactions.opened++;
      try {
        return await fn(tx);
      } catch (err) {
        transactions.failed++;
        throw err;
      }
    },
    close: () => Promise.resolve(),
  };
  return { engine, calls, transactions };
}
