/**
 * `react-native-maps`, loaded at render time. The package reaches for its native module the moment
 * it is evaluated, which throws under Jest, in Expo Go and in a build made before the module
 * landed; every map in this area is optional, so a missing module is one honest "no map" state.
 */
export type MapsModule = typeof import('react-native-maps');

let cached: MapsModule | null | undefined;

export function loadMaps(): MapsModule | null {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
      cached = require('react-native-maps') as MapsModule;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Test seam. */
export function setMapsForTests(module: MapsModule | null | undefined): void {
  cached = module;
}

export interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** The region that fits every point with a margin, or null for none. */
export function regionFor(points: readonly { lat: number; lng: number }[], minDelta = 0.01): Region | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(minDelta, (maxLat - minLat) * 1.25),
    longitudeDelta: Math.max(minDelta, (maxLng - minLng) * 1.25),
  };
}

/** The contiguous US, for a map with nothing to centre on yet. */
export const US_REGION: Region = { latitude: 39.5, longitude: -98.35, latitudeDelta: 28, longitudeDelta: 28 };
