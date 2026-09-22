/**
 * The Android headless task (plan H2, rev1: C2; drive-sense README §6).
 *
 * N3's `CaptureService` starts a headless JS service under the key `DriveSenseTask` when native
 * begins a capture with no app in front (the activity-transition receiver, a sticky restart). The
 * task body boots the runtime as a background launch, lets the drive host run the drive to its
 * end, uploads once from the service (§3.5: "upload from the service or on foreground"), and
 * settles — the native side ends the headless service 2 minutes after capture stops, and bounds
 * the task at 6 h.
 *
 * A boot that fails would leave a capture nobody records: 1 Hz GPS and 25 Hz IMU under a
 * "Recording your drive" notification. So the failure path stops the capture itself, and the
 * native watchdog (no claim within 60 s, no row listener for 5 min) is the second line.
 *
 * iOS has no headless JS: a location wake or a mid-drive relaunch boots the whole app, and
 * `index.ts`'s eager `ensureRuntime()` covers it.
 */
import DriveSense from '@drive-sense';
import { AppRegistry, Platform } from 'react-native';

import type { Db } from '@/data/db';
import type { DriveHost } from '@/drive/host';

import type { AppRuntime } from './bootstrap';
import { ensureRuntime } from './controller';
import { enterHeadless, type LaunchProfile } from './launchProfile';

/** The key N3's `CaptureService` starts the headless service with. Exactly this string. */
export const DRIVE_HEADLESS_TASK = 'DriveSenseTask';

/** How long the task waits for its one upload pass after the drive is finalized. */
export const HEADLESS_DRAIN_TIMEOUT_MS = 60_000;

/**
 * How long an idle host holding a capture it inherited from native waits for that capture's
 * trigger (the buffered wake) to move it: just past native's 60 s claim window, after which the
 * watchdog has stopped an unclaimed capture anyway (README §6).
 */
export const INHERITED_CAPTURE_WAIT_MS = 65_000;

/** The drive-summary notifier (U3), attached here because no layout is mounted headless. */
type AttachNotifier = (host: DriveHost, db: Db) => { detach(): void; settled(): Promise<void> };

/**
 * U3's notifier for the headless task, given the runtime's database (M4 final review m6): the
 * notifier plans delivery from it, and must not depend on the runtime having attached first.
 */
export function attachHeadlessSummaryNotifier(host: DriveHost, db: Db): { detach(): void; settled(): Promise<void> } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: expo-notifications
  const { attachSummaryNotifier } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
  return attachSummaryNotifier(host, { db });
}

export interface DriveHeadlessTaskDeps {
  ensureRuntime: (profile: LaunchProfile) => Promise<AppRuntime>;
  /** drive-sense `stopCapture`. */
  stopCapture: () => Promise<void>;
  report: (error: unknown) => void;
  attachNotifier?: AttachNotifier;
}

function warn(error: unknown): void {
  if (__DEV__) console.warn('[headless]', error);
}

/**
 * Resolves with `promise`'s outcome, or — after `ms` — resolves anyway and reports. A slow upload
 * is not a failed boot: the drive is finalized by then, and stopping capture over it could end a
 * drive that has started since.
 */
async function bounded(
  promise: Promise<unknown>,
  ms: number,
  report: (error: unknown) => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      report(new Error(`headless drain did not answer within ${ms} ms`));
      resolve();
    }, ms);
  });
  try {
    await Promise.race([promise.then(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The drive is over: finalized and idle. `untilIdle` alone can answer too early on the path this
 * task exists for — native started the capture, and its buffered wake is delivered to the new
 * listener asynchronously, so the first look can find the engine still `armed` with a capture
 * running. In that one case wait (bounded) for the host to move, then for it to be idle again.
 */
async function untilDriveDone(host: DriveHost): Promise<void> {
  await host.untilIdle();
  if (!host.captureActive()) return;
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    unsubscribe = host.subscribe(() => resolve());
    timer = setTimeout(resolve, INHERITED_CAPTURE_WAIT_MS);
  });
  unsubscribe();
  clearTimeout(timer);
  await host.untilIdle();
}

/** The task body. Never rejects: a rejected headless task is only an error in the Android log. */
export function createDriveHeadlessTask(
  deps: DriveHeadlessTaskDeps
): (data: unknown) => Promise<void> {
  return async () => {
    const leave = enterHeadless();
    let notifier: ReturnType<AttachNotifier> | null = null;
    try {
      let rt: AppRuntime;
      try {
        rt = await deps.ensureRuntime('background');
      } catch (error) {
        // Only a boot that failed stops the capture: nobody would record it otherwise.
        await deps.stopCapture().catch(() => {});
        throw error;
      }
      // Past boot, the runtime is shared (the app may be open on it): an error here is reported,
      // and a live drive is never stopped over it (H2 r1 m1).
      notifier = deps.attachNotifier?.(rt.drive, rt.db) ?? null;
      await untilDriveDone(rt.drive);
      // A drain the finalize already woke is waited for before this task's own bounded pass, so
      // the task never settles mid-upload (H2 r1 m2). The whole wait is inside the bound.
      await bounded(
        (async () => {
          await rt.runner.idle();
          await Promise.all([rt.runner.drainOnce(), notifier?.settled()]);
        })(),
        HEADLESS_DRAIN_TIMEOUT_MS,
        deps.report
      );
    } catch (error) {
      deps.report(error);
    } finally {
      notifier?.detach();
      leave();
    }
  };
}

export interface RegisterDeps {
  os?: string;
  registry?: Pick<typeof AppRegistry, 'registerHeadlessTask'>;
  task?: DriveHeadlessTaskDeps;
}

/** Android only: registers `DriveSenseTask`. Returns whether it registered. */
export function registerDriveHeadlessTask(deps: RegisterDeps = {}): boolean {
  if ((deps.os ?? Platform.OS) !== 'android') return false;
  const task = createDriveHeadlessTask(
    deps.task ?? {
      ensureRuntime,
      stopCapture: () => DriveSense.stopCapture(),
      report: warn,
      attachNotifier: attachHeadlessSummaryNotifier,
    }
  );
  (deps.registry ?? AppRegistry).registerHeadlessTask(DRIVE_HEADLESS_TASK, () => task);
  return true;
}
