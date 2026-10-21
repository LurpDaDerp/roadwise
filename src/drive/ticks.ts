// The engine's one clock tick: the automatic end (`autoEndAt`, 5 min without movement, or 12 h)
// can pass with no row arriving (a lost fix in a garage, a capture that stopped emitting), so the
// host keeps a single timeout to that time and nothing else.
//
// Lazy re-arm: while the car moves, `autoEndAt` moves later every second. A timer already armed at
// or before the new time is kept; when it fires, the tick re-checks (a no-op when the drive is not
// due) and the host's next `update` arms the new time. So there is at most one re-arm per 5 min
// while driving, and never a timer shorter than `TICK_MIN_DELAY_MS` (no 0 ms loop).

/** The tick fires this long after the deadline, so it is never early against the row clock. */
export const TICK_SLACK_MS = 1000;
/** The ticker never arms sooner than this. */
export const TICK_MIN_DELAY_MS = 1000;

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** When the tick for an automatic end at `autoEndAt` fires. */
export const autoEndDeadline = (autoEndAt: number): number => autoEndAt + TICK_SLACK_MS;

export interface Ticker {
  /** Tell the ticker the engine's `autoEndAt` (null: no drive); call after every settled change. */
  update(autoEndAt: number | null): void;
  stop(): void;
}

export function createTicker(deps: { now: () => number; scheduler?: Scheduler; onTick: (ts: number) => void }): Ticker {
  const scheduler = deps.scheduler ?? realScheduler;
  /** The deadline the armed timer fires for. */
  let armedFor: number | null = null;
  let handle: unknown = null;

  function clear(): void {
    if (handle !== null) scheduler.clearTimeout(handle);
    handle = null;
    armedFor = null;
  }

  return {
    update(autoEndAt) {
      if (autoEndAt === null) {
        clear();
        return;
      }
      const at = autoEndDeadline(autoEndAt);
      // Lazy: an armed timer at or before the new deadline fires first and the tick re-checks.
      if (handle !== null && armedFor !== null && armedFor <= at) return;
      clear();
      armedFor = at;
      handle = scheduler.setTimeout(() => {
        handle = null;
        armedFor = null;
        deps.onTick(deps.now());
      }, Math.max(TICK_MIN_DELAY_MS, at - deps.now()));
    },
    stop: clear,
  };
}
