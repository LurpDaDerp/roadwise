/**
 * The Android headless task (drive-sense README §6).
 *
 * The native `CaptureService` starts a headless JS service under `DriveSenseTask` when a drive
 * records with no app in front: a plain capture's sticky restart after the process died mid-drive,
 * a drive detector drive resumed from its journal in a new process, or an automatic drive the
 * detector's watch confirmed in the background. The task body
 * boots the runtime as a background launch (whose recovery continues the drive the user started,
 * takes the detector's drive in from its journal, or finalizes it as an orphan), lets the host run
 * it to its end, uploads once from the service, and settles. It never starts a drive: with nothing
 * to continue, a plain capture is stopped. A detector drive is never stopped from here: native owns
 * it (its safety stop and 12 h cap end it), as on iPhone, and the boot has already taken it in
 * unless the driver is signed out (then it waits for the same driver's next sign-in).
 *
 * iOS has no headless JS: a mid-drive relaunch boots the whole app, and `index.ts`'s eager
 * `ensureRuntime()` covers it.
 */
import DriveSense, { DriveDetect } from '@drive-sense';
import { AppRegistry, Platform } from 'react-native';

import { reportError } from '@/lib/crashReport';

import type { AppRuntime } from './bootstrap';
import { ensureRuntime } from './controller';
import { enterHeadless, type LaunchProfile } from './launchProfile';

/** The key the native `CaptureService` starts the headless service with. Exactly this string. */
export const DRIVE_HEADLESS_TASK = 'DriveSenseTask';

/** How long the task waits for its one upload pass after the drive is finalized. */
export const HEADLESS_DRAIN_TIMEOUT_MS = 60_000;

export interface DriveHeadlessTaskDeps {
  ensureRuntime: (profile: LaunchProfile) => Promise<AppRuntime>;
  stopCapture: () => Promise<void>;
  report: (error: unknown) => void;
  /** Whether the drive detector records a drive (native's own, never stopped from here); default: none. */
  detectorRecording?: () => Promise<boolean>;
}

/** The detector records a drive (recording or ending); false with no detector or an unreadable state. */
export async function detectorRecording(): Promise<boolean> {
  if (!DriveDetect.available) return false;
  try {
    const s = await DriveDetect.getState();
    return s.state === 'recording' || s.state === 'ending';
  } catch {
    return false;
  }
}

/** The default error hook: the dev console, and the crash sink (release builds only, rate-limited). */
function warn(error: unknown): void {
  if (__DEV__) console.warn('[headless]', error);
  reportError(error, 'headless');
}

async function bounded(promise: Promise<unknown>, ms: number, report: (error: unknown) => void): Promise<void> {
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

/** The task body. Never rejects: a rejected headless task is only an error in the Android log. */
export function createDriveHeadlessTask(deps: DriveHeadlessTaskDeps): (data: unknown) => Promise<void> {
  return async () => {
    const leave = enterHeadless();
    try {
      let rt: AppRuntime;
      try {
        rt = await deps.ensureRuntime('background');
      } catch (error) {
        // Only a boot that failed stops a plain capture: nobody would record it otherwise. A drive
        // the detector records is native's own and records on (the next good boot takes it in). An
        // unreadable state stops, and never hides the boot's error.
        const native = await (deps.detectorRecording ?? (async () => false))().catch(() => false);
        if (!native) await deps.stopCapture().catch(() => {});
        throw error;
      }
      // Nothing to continue (the drive was finalized as an orphan, or there was none): the capture
      // native restarted must not run on with no drive behind it. Read only now, after the boot has
      // taken any detector drive in; a detector drive the host does not hold is native's own.
      if (!rt.drive.isBusy() && !(await (deps.detectorRecording ?? (async () => false))())) await deps.stopCapture().catch(() => {});
      await rt.drive.untilIdle();
      await bounded(
        (async () => {
          await rt.runner.idle();
          // The launch's own recap notifier posts the drive's recap (once); the task waits for it.
          await Promise.all([rt.runner.drainOnce(), rt.notifierSettled()]);
        })(),
        HEADLESS_DRAIN_TIMEOUT_MS,
        deps.report
      );
    } catch (error) {
      deps.report(error);
    } finally {
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
      detectorRecording,
    }
  );
  (deps.registry ?? AppRegistry).registerHeadlessTask(DRIVE_HEADLESS_TASK, () => task);
  return true;
}
