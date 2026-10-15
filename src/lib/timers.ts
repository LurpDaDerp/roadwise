// Timers that also fire from native activity.
//
// Android pauses every JS timer while the app is in the background: React Native's
// `JavaTimerManager` stops its frame callback on `onHostPause` unless a headless JS task is running,
// and a drive started by a tap runs none. Native events still reach JS there: the drive's 1 Hz rows
// and the dashcam's BLE frames. A timer made here fires from the JS timer as usual, OR from `pump()`
// once it is due, whichever comes first, and only once. The drive host pumps on every row and the
// BLE transport on every frame, so a timeout the alert player or the DashPal link waits on is
// released by the next row or frame in the Android background (at most a row late), and on time
// everywhere else. iOS keeps its JS timers running in the background (`RCTTiming` uses NSTimer), so
// there the pump finds nothing due.
//
// Nothing runs between calls: `pump()` only looks at timers already armed, and a process with none
// costs nothing.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PumpedTimers extends Timers {
  /** Resolves after `ms` (by the JS timer or a pump). */
  sleep(ms: number): Promise<void>;
  /** Fire, in due order, every timer due by now. A throwing callback does not stop the others. */
  pump(): void;
  /** Timers armed and not yet fired or cleared. */
  pending(): number;
}

export interface PumpedTimersBase {
  /** A monotonic clock, ms. Default `performance.now()` (falling back to `Date.now()`). */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Entry {
  id: number;
  due: number;
  fn: () => void;
  handle: unknown;
}

function monotonicNow(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
}

export function createPumpedTimers(base: PumpedTimersBase = {}): PumpedTimers {
  // Read at call time, so a test's fake timers installed after this module loaded still apply.
  const now = base.now ?? monotonicNow;
  const arm = base.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const disarm = base.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<number, Entry>();
  let nextId = 1;

  function fire(e: Entry): void {
    if (!entries.delete(e.id)) return;
    e.fn();
  }

  const self: PumpedTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      const e: Entry = { id, due: now() + Math.max(0, ms), fn, handle: null };
      entries.set(id, e);
      e.handle = arm(() => fire(e), ms);
      return id;
    },

    clearTimeout(handle) {
      if (typeof handle !== 'number') return;
      const e = entries.get(handle);
      if (!e) return;
      entries.delete(handle);
      disarm(e.handle);
    },

    sleep(ms) {
      return new Promise<void>((resolve) => {
        self.setTimeout(resolve, ms);
      });
    },

    pump() {
      if (entries.size === 0) return;
      const at = now();
      const due = [...entries.values()].filter((e) => e.due <= at).sort((a, b) => a.due - b.due || a.id - b.id);
      let failure: { error: unknown } | null = null;
      for (const e of due) {
        if (!entries.has(e.id)) continue;
        disarm(e.handle);
        try {
          fire(e);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
    },

    pending: () => entries.size,
  };
  return self;
}

/** The process's pumped timers: the alert player, its ports, the DashPal runtime and transport. */
export const processTimers: PumpedTimers = createPumpedTimers();
