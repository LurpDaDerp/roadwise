// Automatic drives on iPhone (modes plan §3.1.4): the native drive detector runs only for a
// signed-in, onboarded driver who allowed Location Always, Precise Location and Motion & Fitness.
// This is the one place that arms or disarms it (`DriveDetect.setArmed`):
// - `autoDetectSync()` arms it at onboarding's finish, at sign-in and on every return to the front
//   while that holds (native answers `needs` and stays off while a permission is missing), and
//   disarms it otherwise;
// - `autoDetectOff()` disarms it at sign-out, an account switch and the account's deletion (the
//   device wipes).
// Android has no detector: every call is a no-op and `readAutoDetectStatus()` answers null.
import type { DetectMissing, DetectState, DriveDetectApi } from '@drive-sense';

import { createSettingsRepo, type Db } from '@/data/db';
import { nativeDriveDetect } from '@/drive/source';

/** The signed-in driver last seen onboarded on this phone (settings; the device wipes take it). */
export const AUTO_DETECT_ONBOARDED_KEY = 'autoDetect.onboarded';
/** Native's owner id when none is signed in (disarming needs one). */
const NO_OWNER = 'none';

export interface AutoDetectRuntime {
  db: Db;
  /** The detector (null on Android); default the native module. */
  detect?: DriveDetectApi | null;
  /** The signed-in driver's id, or null when signed out. */
  uid(): Promise<string | null>;
  /** Whether the server says this driver finished onboarding (the cached summary); unknown is false. */
  onboarded?(uid: string): boolean | Promise<boolean>;
  onError?(e: unknown, ctx: string): void;
}

let runtime: AutoDetectRuntime | null = null;

/** The bootstrap registers the live runtime (null when it stops). */
export function setAutoDetectRuntime(next: AutoDetectRuntime | null): void {
  runtime = next;
}

function detector(): DriveDetectApi | null {
  if (runtime?.detect !== undefined) return runtime.detect !== null && runtime.detect.available ? runtime.detect : null;
  return nativeDriveDetect();
}

const report = (e: unknown, ctx: string): void => {
  try {
    runtime?.onError?.(e, ctx);
  } catch {
    // nobody left to tell
  }
};

export type AutoDetectResult = 'on' | 'needs' | 'off' | 'unsupported';

/**
 * Arm the detector when a driver is signed in and onboarded, else disarm it. `onboarded: true`
 * (onboarding's finish) records that this driver is onboarded. Never rejects.
 */
export async function autoDetectSync(opts: { onboarded?: boolean } = {}): Promise<AutoDetectResult> {
  const detect = detector();
  const rt = runtime;
  if (detect === null || rt === null) return 'unsupported';
  try {
    const settings = createSettingsRepo(rt.db);
    const uid = await rt.uid();
    let onboarded = false;
    if (uid !== null) {
      if (opts.onboarded === true) await settings.set(AUTO_DETECT_ONBOARDED_KEY, uid);
      onboarded = (await settings.get<string>(AUTO_DETECT_ONBOARDED_KEY)) === uid;
      if (!onboarded && (await rt.onboarded?.(uid)) === true) {
        onboarded = true;
        await settings.set(AUTO_DETECT_ONBOARDED_KEY, uid);
      }
    }
    if (uid === null || !onboarded) {
      await detect.setArmed(false, uid ?? NO_OWNER);
      return 'off';
    }
    const state = await detect.setArmed(true, uid);
    return state.status === 'on' ? 'on' : state.status === 'needs' ? 'needs' : 'off';
  } catch (e) {
    report(e, 'autoDetect');
    return 'off';
  }
}

/** Disarm the detector (sign-out, account switch, deletion). Best effort; never rejects. */
export async function autoDetectOff(): Promise<void> {
  const detect = detector();
  if (detect === null) return;
  try {
    await detect.setArmed(false, NO_OWNER);
  } catch (e) {
    report(e, 'autoDetectOff');
  }
}

export interface AutoDetectStatus {
  armed: boolean;
  status: DetectState['status'];
  missing: DetectMissing[];
  permissions: DetectState['permissions'];
}

/** What Settings and Home say about automatic drives; null on Android or when it cannot be read. */
export async function readAutoDetectStatus(): Promise<AutoDetectStatus | null> {
  const detect = detector();
  if (detect === null) return null;
  try {
    const s = await detect.getState();
    return { armed: s.armed, status: s.status, missing: s.missing, permissions: s.permissions };
  } catch (e) {
    report(e, 'autoDetectStatus');
    return null;
  }
}
