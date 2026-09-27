// The camera beta's opt-in (A10): off by default, adults only, behind the remote `camera_beta` flag.
//
// - Turning it ON records the versioned `camera` consent on the server first (the audit trail of the words the driver
//   agreed to, `cameraConsent` in copy.ts), then stores the choice on this phone. A consent the server did not take
//   leaves it off: the driver sees an error and nothing runs.
// - Turning it OFF is local and immediate: the next gate read closes the camera. The server's consent row is
//   append-only for the client (0001_foundation: insert only); the local choice is what the gate reads.
// - The choice is per account: a record for another uid, another consent version or a malformed value reads as off.
//   The handover wipe removes it with every other setting.
import type { SettingsRepo } from '@/data/db/settings';

/** Names the consent text in copy.ts. Bump it with any change to what that text says. */
export const CAMERA_CONSENT_VERSION = 'camera-beta-1';

export const CAMERA_OPT_IN_KEY = 'camera.optIn';

interface StoredOptIn {
  uid: string;
  version: string;
  on: boolean;
}

/** On only for this uid's record of the current consent version. Never rejects: a failed read is off. */
export async function readCameraOptIn(settings: Pick<SettingsRepo, 'get'>, uid: string | null): Promise<boolean> {
  if (uid === null) return false;
  try {
    const v = await settings.get<unknown>(CAMERA_OPT_IN_KEY);
    if (typeof v !== 'object' || v === null) return false;
    const s = v as Partial<StoredOptIn>;
    return s.uid === uid && s.version === CAMERA_CONSENT_VERSION && s.on === true;
  } catch {
    return false;
  }
}

export interface OptInDeps {
  settings: Pick<SettingsRepo, 'set'>;
  /** records `consents(type='camera', version)` for `uid`; rejects when the server did not take it */
  recordConsent(uid: string, consent: { type: 'camera'; version: string }): Promise<unknown>;
}

/** On: the consent is recorded first, then the choice is stored. Rejects (leaving it off) when either fails. */
export async function turnCameraOn(deps: OptInDeps, uid: string): Promise<void> {
  await deps.recordConsent(uid, { type: 'camera', version: CAMERA_CONSENT_VERSION });
  await deps.settings.set(CAMERA_OPT_IN_KEY, { uid, version: CAMERA_CONSENT_VERSION, on: true } satisfies StoredOptIn);
  notify();
}

/** Off: local, immediate. */
export async function turnCameraOff(settings: Pick<SettingsRepo, 'set'>, uid: string): Promise<void> {
  await settings.set(CAMERA_OPT_IN_KEY, { uid, version: CAMERA_CONSENT_VERSION, on: false } satisfies StoredOptIn);
  notify();
}

/** Who can have it at all: an adult account with the flag on. */
export type CameraEligibility = 'ok' | 'age' | 'flag_off';

export function cameraEligibility(ageBand: string | null | undefined, flagOn: boolean): CameraEligibility {
  if (ageBand !== '18_plus') return 'age';
  if (!flagOn) return 'flag_off';
  return 'ok';
}

// A change of the choice re-evaluates the running drive's gate at once (the bridge listens), so turning it off
// mid-drive stops the camera in the same tick.
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a listener that throws does not stop the others
    }
  }
}
export function subscribeCameraOptIn(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
