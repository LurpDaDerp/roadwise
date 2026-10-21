/**
 * The Android headless task (drive-sense README §6).
 *
 * The native `CaptureService` starts a headless JS service under `DriveSenseTask` when it restarts
 * a capture with no app in front (a sticky restart after the process died mid-drive). The task body
 * boots the runtime as a background launch — whose recovery continues the drive the user started,
 * or finalizes it as an orphan — lets the host run it to its end, uploads once from the service,
 * and settles. It never starts a drive: with nothing to continue, the capture is stopped.
 *
 * iOS has no headless JS: a mid-drive relaunch boots the whole app, and `index.ts`'s eager
 * `ensureRuntime()` covers it.
 */
import DriveSense from '@drive-sense';
import { AppRegistry, Platform } from 'react-native';

import type { Db } from '@/data/db';
import type { DriveHost } from '@/drive/host';

import type { AppRuntime } from './bootstrap';
import { ensureRuntime } from './controller';
import { enterHeadless, type LaunchProfile } from './launchProfile';

/** The key the native `CaptureService` starts the headless service with. Exactly this string. */
export const DRIVE_HEADLESS_TASK = 'DriveSenseTask';

/** How long the task waits for its one upload pass after the drive is finalized. */
export const HEADLESS_DRAIN_TIMEOUT_MS = 60_000;

type AttachNotifier = (host: DriveHost, db: Db) => { detach(): void; settled(): Promise<void> };

export function attachHeadlessSummaryNotifier(host: DriveHost, db: Db): { detach(): void; settled(): Promise<void> } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: expo-notifications
  const { attachSummaryNotifier, summaryUnits } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
  return attachSummaryNotifier(host, { units: summaryUnits(db) });
}

export interface DriveHeadlessTaskDeps {
  ensureRuntime: (profile: LaunchProfile) => Promise<AppRuntime>;
  stopCapture: () => Promise<void>;
  report: (error: unknown) => void;
  attachNotifier?: AttachNotifier;
}

function warn(error: unknown): void {
  if (__DEV__) console.warn('[headless]', error);
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
      // Nothing to continue (the drive was finalized as an orphan, or there was none): the capture
      // native restarted must not run on with no drive behind it.
      if (!rt.drive.isBusy()) await deps.stopCapture().catch(() => {});
      notifier = deps.attachNotifier?.(rt.drive, rt.db) ?? null;
      await rt.drive.untilIdle();
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
