/**
 * What a manual drive needs before it can start (§7.C C1 "Permissions: Location (required),
 * Motion"): foreground location, and motion.
 *
 * - Every read and request goes through Task 8's adapter (`createPermissionsAdapter`); nothing here
 *   calls an Expo permission API (rev1: I3 — one permission system).
 * - The prompts here are started by the app, not by a tap on a Fix button, so each goes through
 *   `offerPrompt`: at most one OS prompt per permission in 14 days (product §8.3), recorded when made.
 * - Location is required. An undetermined permission is asked (inside the window); a denied one is
 *   never asked again from here (§7.0 "Never re-prompt in a loop"). The caller shows the blocking
 *   explainer with Open Settings, and re-reads with `readLocationPermission` on the way back.
 * - Motion is asked once when undetermined and never blocks: a manual drive records without it.
 * - Background location ("Always") is never asked here: only `BackgroundDisclosure` asks for it.
 */
import {
  createPermissionsAdapter,
  offerPrompt,
  type Grant,
  type LocationAccess,
  type PermissionsAdapter,
  type SettingsStore,
} from '@/core/permissions';

export type LocationPermission = 'granted' | 'denied' | 'undetermined';
export type MotionPermission = Grant;

export interface DrivePermissions {
  location: 'granted' | 'denied';
  motion: MotionPermission;
}

export interface PermissionDeps {
  adapter?: Pick<
    PermissionsAdapter,
    'snapshot' | 'requestLocationForeground' | 'requestMotion' | 'openAppSettings'
  >;
  /** Where the 14-day prompt history lives (the settings repo). */
  settings: SettingsStore;
  now?: () => number;
}

const asLocation = (access: LocationAccess): LocationPermission =>
  access === 'always' || access === 'foreground'
    ? 'granted'
    : access === 'undetermined'
      ? 'undetermined'
      : 'denied';

let sharedAdapter: PermissionsAdapter | null = null;

/** The device adapter, made on first use; it loads nothing native until a method is called. */
const adapterOf = (deps: Partial<Pick<PermissionDeps, 'adapter'>>) =>
  deps.adapter ?? (sharedAdapter ??= createPermissionsAdapter());

/** Read only — never prompts. For the return from Settings. A phone that can't be read is denied. */
export async function readLocationPermission(
  deps: Partial<Pick<PermissionDeps, 'adapter'>> = {}
): Promise<LocationPermission> {
  try {
    return asLocation((await adapterOf(deps).snapshot()).location);
  } catch {
    return 'denied';
  }
}

export async function ensureDrivePermissions(deps: PermissionDeps): Promise<DrivePermissions> {
  const adapter = adapterOf(deps);
  const now = deps.now ?? Date.now;
  let snap;
  try {
    snap = await adapter.snapshot();
  } catch {
    return { location: 'denied', motion: 'undetermined' };
  }

  let location = asLocation(snap.location);
  if (location === 'undetermined') {
    try {
      const answer = await offerPrompt(deps.settings, 'location', now(), () =>
        adapter.requestLocationForeground()
      );
      // Inside the 14-day window nothing is asked: the explainer's Open Settings is the way on.
      location = answer === 'skipped' ? 'denied' : asLocation(answer);
    } catch {
      location = 'denied';
    }
  }
  if (location !== 'granted') return { location: 'denied', motion: 'undetermined' };

  // null: drive-sense could not be read (no native module) — motion is simply not there to use.
  let motion: MotionPermission = snap.motion ?? 'unavailable';
  if (motion === 'undetermined') {
    try {
      const answer = await offerPrompt(deps.settings, 'motion', now(), () => adapter.requestMotion());
      motion = answer === 'skipped' ? 'undetermined' : (answer ?? 'unavailable');
    } catch {
      motion = 'unavailable';
    }
  }
  return { location: 'granted', motion };
}

/** The app's own page in the system Settings. */
export function openAppSettings(deps: Partial<Pick<PermissionDeps, 'adapter'>> = {}): Promise<void> {
  return adapterOf(deps).openAppSettings();
}
