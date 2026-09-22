/**
 * Work that may run only while the driver is looking at the app, and not too often even then
 * (design §3.5; M3 plan R10/R13, review I3).
 *
 * An eager runtime boots on every background wake — an iOS region exit, a significant-location
 * change, the Android headless task — and iOS wakes an armed phone many times a day with no drive.
 * Anything that touches the network on those wakes is radio time the battery budget has no room
 * for. So hydration and the config fetch are registered here and run only on a transition to
 * `active` (or at registration, when the app is already known to be active), and at most once per
 * `minIntervalMs`. The last successful run is stamped in `settings`, so the throttle survives a
 * relaunch — a driver who opens the app ten times an hour triggers one run, not ten.
 *
 * Rules:
 * - **Never while `AppState !== 'active'`.** An unknown state counts as not active.
 * - **The stamp is written after the job succeeds.** A job that throws (offline, a busy engine,
 *   an incomplete restore) is tried again at the next foreground, not six hours later.
 * - **One run at a time per registration.** A foreground that arrives while the job is still
 *   running does not start a second one.
 * - **No timer.** Nothing here schedules anything: the only trigger is the OS telling us the app
 *   came forward, so an armed-idle phone costs nothing.
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';

/** React Native's `AppState`, narrowed to what this needs. `currentState` is read at registration. */
export interface AppStateLike {
  currentState?: string | null;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/** Where the last successful run of job `key` is stamped (epoch ms). */
export const foregroundStampKey = (key: string): string => `foreground.${key}.lastRunAt`;

export interface ForegroundDeps {
  appState: AppStateLike;
  now: () => number;
  db: Db;
  /** Told about a job or stamp failure; the job is simply tried again at the next foreground. */
  onError?: (error: unknown, context: string) => void;
}

/**
 * Run `job` on every transition to `active`, throttled to once per `minIntervalMs` by a settings
 * timestamp. Returns the unsubscribe; a run already in flight finishes but stamps nothing after it.
 */
export function runWhenForeground(
  key: string,
  minIntervalMs: number,
  job: () => Promise<void>,
  deps: ForegroundDeps
): () => void {
  const settings = createSettingsRepo(deps.db);
  const stampKey = foregroundStampKey(key);
  let live = true;
  let running = false;
  /** The last state the OS reported; the job starts only while it is still `active`. */
  let state: string | null | undefined = deps.appState.currentState;

  async function attempt(): Promise<void> {
    if (!live || running) return;
    running = true;
    try {
      const last = await settings.get<number>(stampKey);
      const due = typeof last !== 'number' || deps.now() - last >= minIntervalMs || deps.now() < last;
      // The settings read is a window: the app may have gone to the background during it.
      if (!due || !live || state !== 'active') return;
      await job();
      if (live) await settings.set(stampKey, deps.now());
    } catch (error) {
      deps.onError?.(error, `foreground job ${key}`);
    } finally {
      running = false;
    }
  }

  const subscription = deps.appState.addEventListener('change', (next) => {
    state = next;
    if (next === 'active') void attempt();
  });
  if (state === 'active') void attempt();

  return () => {
    live = false;
    subscription.remove();
  };
}
