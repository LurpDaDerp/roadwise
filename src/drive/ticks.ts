// The engine's clock ticks (M1 host contract: "never add timers to the engine").
//
// The engine only learns that time has passed from the `ts` on what it is given. Two of its
// deadlines can pass with nothing arriving: the auto-detect window of a candidate that never
// confirms, and the gap window of a trip in `ending` (rows are sparse at the low rate, and absent
// underground). So the host keeps a single timeout, to the next of those deadlines, and nothing
// else: no timer while armed, off, recording or finalizing (§3.5).
import { CONSTANTS } from '@scoring';

import type { EngineStatus } from '@/core/engine/engine.types';

const { AUTO_DETECT_WINDOW_S, GAP_MERGE_S } = CONSTANTS;

/**
 * The tick fires this long after the estimated deadline. The engine measures its windows from the
 * `ts` of the event or row that opened them, which is never later than when the host saw the state
 * change, so a deadline taken from the host's clock plus this slack is never early.
 */
export const TICK_SLACK_MS = 1000;
/** If the engine is still in the same state after a tick (a clock step), one more tick this later. */
export const TICK_RETRY_MS = 5000;

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The wall-clock deadline of a state entered at `enteredAt`, or null when it has none. */
export function tickDeadline(status: EngineStatus, enteredAt: number): number | null {
  if (status === 'candidate') return enteredAt + AUTO_DETECT_WINDOW_S * 1000 + TICK_SLACK_MS;
  if (status === 'ending') return enteredAt + GAP_MERGE_S * 1000 + TICK_SLACK_MS;
  return null;
}

export interface Ticker {
  /** Tell the ticker the engine's current status; call after every settled change. */
  update(status: EngineStatus): void;
  stop(): void;
}

export function createTicker(deps: {
  now: () => number;
  scheduler?: Scheduler;
  onTick: (ts: number) => void;
}): Ticker {
  const scheduler = deps.scheduler ?? realScheduler;
  let status: EngineStatus | null = null;
  let deadline: number | null = null;
  let handle: unknown = null;

  function clear(): void {
    if (handle !== null) scheduler.clearTimeout(handle);
    handle = null;
  }

  function arm(at: number): void {
    clear();
    handle = scheduler.setTimeout(() => {
      handle = null;
      deps.onTick(deps.now());
    }, Math.max(0, at - deps.now()));
  }

  return {
    update(next) {
      if (next !== status) {
        status = next;
        deadline = tickDeadline(next, deps.now());
        if (deadline === null) clear();
        else arm(deadline);
        return;
      }
      // Same state, and its timer has fired: the engine did not see the deadline pass (the clock
      // moved). One retry, not a loop — the next update after it schedules the next.
      if (deadline !== null && handle === null) arm(Math.max(deadline, deps.now() + TICK_RETRY_MS));
    },
    stop() {
      clear();
      status = null;
      deadline = null;
    },
  };
}
