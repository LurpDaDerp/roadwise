// A JS timer base that can be paused, as Android pauses JS timers with the app in the background
// (React Native's JavaTimerManager, no headless task): while paused, `advance` moves the clock and
// fires nothing. Feed it to `createPumpedTimers` to model a phone-away drive.

export interface PausableTimerBase {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** true: the app is in the Android background; armed timers stay unfired. */
  pause(on: boolean): void;
  paused(): boolean;
  /** Move the clock; fire what is due unless paused. */
  advance(ms: number): void;
  /** JS timers armed and not fired or cleared. */
  armed(): number;
}

export function createPausableTimerBase(start = 0): PausableTimerBase {
  let t = start;
  let isPaused = false;
  let id = 0;
  const armed = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      id += 1;
      armed.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      armed.delete(handle as number);
    },
    pause(on) {
      isPaused = on;
    },
    paused: () => isPaused,
    advance(ms) {
      t += ms;
      if (isPaused) return;
      const due = [...armed].filter(([, a]) => a.at <= t).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      for (const [k, a] of due) {
        if (!armed.delete(k)) continue;
        a.fn();
      }
    },
    armed: () => armed.size,
  };
}
