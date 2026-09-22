/**
 * What a manual drive needs before it can start (§7.C C1 "Permissions: Location (required),
 * Motion"): foreground location, and motion.
 *
 * - Location is required. An undetermined permission is asked once; a denied one is never asked
 *   again from here (§7.0 "Never re-prompt in a loop") — the caller shows the blocking explainer
 *   with Open Settings, and re-reads with `readLocationPermission` when the app comes back.
 * - Motion is asked once when undetermined and never blocks: a manual drive records without it.
 * - Background location ("Always") is not asked here: that is auto-record's (R16, DetectionScreen).
 */
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import DriveSense, { type DriveSenseState } from '@drive-sense';

export type LocationPermission = 'granted' | 'denied' | 'undetermined';
export type MotionPermission = DriveSenseState['motion'];

export interface DrivePermissions {
  location: 'granted' | 'denied';
  motion: MotionPermission;
}

export interface PermissionDeps {
  location: {
    getForegroundPermissionsAsync(): Promise<{ status: string }>;
    requestForegroundPermissionsAsync(): Promise<{ status: string }>;
  };
  driveSense: {
    getState(): Promise<Pick<DriveSenseState, 'motion'>>;
    requestMotionPermission(): Promise<'granted' | 'denied' | 'unavailable'>;
  };
}

const defaultDeps: PermissionDeps = { location: Location, driveSense: DriveSense };

const asLocation = (status: string): LocationPermission =>
  status === 'granted' ? 'granted' : status === 'undetermined' ? 'undetermined' : 'denied';

/** Read only — never prompts. For the return from Settings. */
export async function readLocationPermission(
  deps: PermissionDeps = defaultDeps
): Promise<LocationPermission> {
  try {
    return asLocation((await deps.location.getForegroundPermissionsAsync()).status);
  } catch {
    return 'denied';
  }
}

async function ensureMotion(deps: PermissionDeps): Promise<MotionPermission> {
  try {
    const { motion } = await deps.driveSense.getState();
    if (motion !== 'undetermined') return motion;
    return await deps.driveSense.requestMotionPermission();
  } catch {
    // No native module (Expo Go, a failed bridge): motion is simply not there to use.
    return 'unavailable';
  }
}

export async function ensureDrivePermissions(
  deps: PermissionDeps = defaultDeps
): Promise<DrivePermissions> {
  let location = await readLocationPermission(deps);
  if (location === 'undetermined') {
    try {
      location = asLocation((await deps.location.requestForegroundPermissionsAsync()).status);
    } catch {
      location = 'denied';
    }
  }
  if (location !== 'granted') return { location: 'denied', motion: 'undetermined' };
  return { location: 'granted', motion: await ensureMotion(deps) };
}

/** The app's own page in the system Settings. */
export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}
