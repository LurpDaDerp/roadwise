// Automatic drives on iPhone (modes plan §3.1.4): the native drive detector runs only for a
// signed-in, onboarded driver who allowed Location Always, Precise Location and Motion & Fitness.
// This is the one place that arms or disarms it (`DriveDetect.setArmed`):
// - `autoDetectSync()` arms it at onboarding's finish, at sign-in and on every return to the front
//   while that holds (native answers `needs` and stays off while a permission is missing), and
//   disarms it for a driver who is signed out or not onboarded. A session that cannot be read (an
//   expired token that cannot refresh with no network) is not a sign-out: the arming stays as it is;
// - `autoDetectOff()` disarms it at every session end; the device wipes (sign-out with nothing
//   owed, an account switch, the account's deletion) also wipe native's drive state
//   (`DriveDetect.wipe()`: every journal, the last end, the parked spot and a rest), so nothing of
//   one driver's reaches the next.
// Android has no detector: every call is a no-op and `readAutoDetectStatus()` answers null.
import type { DetectMissing, DetectState, DriveDetectApi } from '@drive-sense';

import { createSettingsRepo, type Db } from '@/data/db';
import { nativeDriveDetect } from '@/drive/source';

/** The signed-in driver last seen onboarded on this phone (settings; the device wipes take it). */
export const AUTO_DETECT_ONBOARDED_KEY = 'autoDetect.onboarded';
/** The owner id to disarm with when neither native nor the session knows one (the wrapper refuses an empty one). */
const NO_OWNER = 'none';

export interface AutoDetectRuntime {
  db: Db;
  /** The detector (null on Android); default the native module. */
  detect?: DriveDetectApi | null;
  /**
   * The signed-in driver's id, or null when signed out. Rejects when the session cannot be read
   * (an expired access token that cannot refresh offline, a storage failure): unknown, which never
   * disarms.
   */
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

/**
 * Who to disarm for: the owner native is armed for (so a disarm never reads as an owner change),
 * else the signed-in driver, else `NO_OWNER`.
 */
async function ownerToDisarm(detect: DriveDetectApi, uid: string | null): Promise<string> {
  try {
    const armedFor = (await detect.getState()).ownerId;
    if (armedFor) return armedFor;
  } catch {
    // unreadable: fall back to the session's driver
  }
  return uid ?? NO_OWNER;
}

const report = (e: unknown, ctx: string): void => {
  try {
    runtime?.onError?.(e, ctx);
  } catch {
    // nobody left to tell
  }
};

export type AutoDetectResult = 'on' | 'needs' | 'off' | 'unsupported';

const resultOf = (state: DetectState): AutoDetectResult => (state.status === 'on' ? 'on' : state.status === 'needs' ? 'needs' : 'off');

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
    let uid: string | null;
    try {
      uid = await rt.uid();
    } catch {
      // Unknown is not signed out: the arming stays as it is (a real sign-out disarms at the session's end).
      return resultOf(await detect.getState());
    }
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
      await detect.setArmed(false, uid ?? (await ownerToDisarm(detect, null)));
      return 'off';
    }
    return resultOf(await detect.setArmed(true, uid));
  } catch (e) {
    report(e, 'autoDetect');
    return 'off';
  }
}

export interface AutoDetectOffOptions {
  /** The detector to disarm (the launch's, before the runtime is registered); default the runtime's. */
  detect?: DriveDetectApi | null;
  /** Also wipe native's drive state (`DriveDetect.wipe()`: every journal, the last end, the parked region, a rest). */
  wipe?: boolean;
}

/** Disarm the detector (every session end, the device wipes). Best effort; never rejects. */
export async function autoDetectOff(opts: AutoDetectOffOptions = {}): Promise<void> {
  const detect = opts.detect !== undefined ? (opts.detect !== null && opts.detect.available ? opts.detect : null) : detector();
  if (detect === null) return;
  await disarm(detect);
  if (opts.wipe) await wipeNative(detect);
}

async function wipeNative(detect: DriveDetectApi): Promise<void> {
  // A detector without the method (an older native build) has nothing more to wipe.
  if (typeof detect.wipe !== 'function') return;
  try {
    await detect.wipe();
  } catch (e) {
    report(e, 'autoDetectWipe');
  }
}

async function disarm(detect: DriveDetectApi): Promise<void> {
  try {
    let uid: string | null = null;
    try {
      uid = (await runtime?.uid()) ?? null;
    } catch {
      // signed out already, or the session is unreadable: native's own owner, else the placeholder
    }
    await detect.setArmed(false, await ownerToDisarm(detect, uid));
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
