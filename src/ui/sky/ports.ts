import * as Location from 'expo-location';

import type { Place } from './phase';
import type { SkyPorts } from './useSkyMood';
import type { SkyStorage } from './weather';

/**
 * The sky's real ports: the phone's cached position and AsyncStorage. Kept apart from the hook so
 * the hook runs under Jest without native modules.
 */

/**
 * A position the phone already has, without any prompt: only when location is already allowed,
 * and only the OS's cached fix (no GPS of its own). Null otherwise.
 */
export async function lastKnownPlace(): Promise<Place | null> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const pos = await Location.getLastKnownPositionAsync({ maxAge: 24 * 60 * 60_000 });
    return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
  } catch {
    return null;
  }
}

function asyncStorage(): SkyStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    return (require('@react-native-async-storage/async-storage') as { default: SkyStorage }).default;
  } catch {
    return null;
  }
}

/** The ports the app runs on. One object for the app's life, so the hook never re-subscribes. */
export const appSkyPorts: SkyPorts = {
  position: lastKnownPlace,
  storage: asyncStorage(),
};
