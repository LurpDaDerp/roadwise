import { Platform } from 'react-native';

let keyForTests: { key: string | undefined } | undefined;

/** Tests: stand in for the build's Google Maps key (`{ key }`); undefined goes back to the real one. */
export function setMapsKeyForTests(k: { key: string | undefined } | undefined): void {
  keyForTests = k;
}

/**
 * The Google Maps key this Android build was made with, undefined when none. Read from the
 * bundle's own inlined `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY` (the same variable app.config.ts puts
 * in the manifest), never from `Constants.expoConfig.android.config.googleMaps`: Expo strips
 * `android.config` from the public config it embeds in the app and in OTA manifests, so that path
 * is always empty at runtime. Read here by name rather than through `@/lib/env`, which throws when
 * the Supabase variables are missing (the maps have no need of them); Expo inlines the name only
 * where it is spelled out literally, as it is here.
 */
export function androidMapsKey(): string | undefined {
  if (keyForTests) return keyForTests.key;
  const key: unknown = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
  return typeof key === 'string' ? key : undefined;
}

/**
 * Whether this is an Android build made without a Google Maps key. app.config.ts writes the key
 * into the manifest only when the variable is set and not empty (the same test as here), and
 * without it Google's Maps SDK throws "API key not found" the moment a map view is made, which
 * takes the whole app down. Such a build has no maps at all: the same "no map" state as a build
 * without the maps module. iPhone uses Apple's map, which needs no key.
 */
export function googleMapKeyMissing(os: string = Platform.OS): boolean {
  return os === 'android' && !androidMapsKey();
}

/**
 * `react-native-maps`, loaded at render time. The package reaches for its native module the moment
 * it is evaluated, which throws under Jest, in Expo Go and in a build made before the module
 * landed; every map in this area is optional, so a missing module is one honest "no map" state, as
 * is an Android build with no Google Maps key (`googleMapKeyMissing`, read before the cache).
 */
export type MapsModule = typeof import('react-native-maps');

let cached: MapsModule | null | undefined;

export function loadMaps(): MapsModule | null {
  if (googleMapKeyMissing()) return null;
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

/**
 * The widest region both map engines take: Apple's map throws "Invalid Region" on a span over
 * 180° × 360°, and Google's bounds wrap at a full 360° of longitude, so a span of 360° or more
 * opens on a sliver on the wrong side of the world. The caps keep a margin under both (Apple
 * documents no exact limit), which costs nothing: a span this wide is the whole world zoomed all
 * the way out either way. Routes far enough apart to need more (Seattle and Seoul, say) get that.
 */
export const MAX_LAT_DELTA = 170;
export const MAX_LNG_DELTA = 350;

/** The region that fits every point with a margin (never wider than the whole world), or null for none. */
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
    latitudeDelta: Math.min(MAX_LAT_DELTA, Math.max(minDelta, (maxLat - minLat) * 1.25)),
    longitudeDelta: Math.min(MAX_LNG_DELTA, Math.max(minDelta, (maxLng - minLng) * 1.25)),
  };
}

/** The contiguous US, for a map with nothing to centre on yet. */
export const US_REGION: Region = { latitude: 39.5, longitude: -98.35, latitudeDelta: 28, longitudeDelta: 28 };
