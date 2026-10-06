// The engine's one clock tick: the auto-end deadline (300 s stopped) can pass with no row arriving
// (a lost fix in a garage), so the host keeps a single timeout to that deadline and nothing else.
import { AUTO_END_STOPPED_S } from '@scoring';

/** The tick fires this long after the deadline, so it is never early against the row clock. */
export const TICK_SLACK_MS = 1000;

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const autoEndDeadline = (stoppedSinceTs: number): number => stoppedSinceTs + AUTO_END_STOPPED_S * 1000 + TICK_SLACK_MS;

export interface Ticker {
  /** Tell the ticker the engine's stop clock; call after every settled change. */
  update(stoppedSinceTs: number | null): void;
  stop(): void;
}

export function createTicker(deps: { now: () => number; scheduler?: Scheduler; onTick: (ts: number) => void }): Ticker {
  const scheduler = deps.scheduler ?? realScheduler;
  let armedFor: number | null = null;
  let handle: unknown = null;

  function clear(): void {
    if (handle !== null) scheduler.clearTimeout(handle);
    handle = null;
    armedFor = null;
  }

  return {
    update(stoppedSinceTs) {
      if (stoppedSinceTs === null) {
        clear();
        return;
      }
      if (armedFor === stoppedSinceTs && handle !== null) return;
      clear();
      armedFor = stoppedSinceTs;
      const at = autoEndDeadline(stoppedSinceTs);
      handle = scheduler.setTimeout(() => {
        handle = null;
        deps.onTick(deps.now());
      }, Math.max(0, at - deps.now()));
    },
    stop: clear,
  };
}
