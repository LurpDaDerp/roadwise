// An in-memory stand-in for the engine port (`engine.ts`): answers each call from a script,
// records every call in order, and rolls back nothing (there is nothing to roll back) — a handler
// test asserts what was asked of the engine and in which order.
import type { ApplyDisputeEnvelope, ApplyDriveEnvelope, DisputeContext, DriveContext, DriveContextArgs, Engine, EngineTx } from '../engine.ts';

export interface EngineCall {
  fn: keyof EngineTx;
  args: unknown;
}

export interface FakeEngineScript {
  rateLimit?: boolean;
  context?: DriveContext | Error;
  apply?: unknown | Error | ((envelope: ApplyDriveEnvelope) => unknown);
  revert?: unknown | Error;
  disputeContext?: DisputeContext | Error;
  applyDispute?: unknown | Error | ((envelope: ApplyDisputeEnvelope) => unknown);
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
      return Promise.resolve(answer(script.context ?? new Error('no context scripted')));
    },
    applyDrive(envelope) {
      calls.push({ fn: 'applyDrive', args: envelope });
      const a = script.apply ?? new Error('no apply scripted');
      return Promise.resolve(typeof a === 'function' ? (a as (e: ApplyDriveEnvelope) => unknown)(envelope) : answer(a));
    },
    revertNotDriving(userId, clientTripId) {
      calls.push({ fn: 'revertNotDriving', args: { userId, clientTripId } });
      return Promise.resolve(answer(script.revert ?? new Error('no revert scripted')));
    },
    disputeContext(userId, clientTripId, eventId, reason) {
      calls.push({ fn: 'disputeContext', args: { userId, clientTripId, eventId, reason } });
      return Promise.resolve(answer(script.disputeContext ?? new Error('no dispute context scripted')));
    },
    applyDispute(envelope) {
      calls.push({ fn: 'applyDispute', args: envelope });
      const a = script.applyDispute ?? new Error('no apply dispute scripted');
      return Promise.resolve(typeof a === 'function' ? (a as (e: ApplyDisputeEnvelope) => unknown)(envelope) : answer(a));
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
