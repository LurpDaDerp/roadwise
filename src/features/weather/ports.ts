import * as Location from 'expo-location';

/** A place, in degrees. */
export type Place = { lat: number; lng: number };

/** A cached fix older than this says little about the weather where the phone is now. */
const POSITION_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * A position the phone already has, never a prompt: only when location is already allowed, and
 * only the OS's cached fix (no GPS of its own). Null otherwise, and on any failure.
 */
export async function lastKnownPlace(): Promise<Place | null> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm?.granted) return null;
    const pos = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS });
    return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
  } catch {
    return null;
  }
}
