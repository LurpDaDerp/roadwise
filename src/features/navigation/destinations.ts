// Directions to a point in the driver's navigation app (product spec "Driving screen · Navigation").
//
// Only three apps take a destination here, each by its own URL (opened with `Linking.openURL`, no
// native code): Apple Maps (iPhone), Google Maps (iPhone and Android) and Waze (both). Any other
// app has no destination: the caller opens it as it always does, bare. The point goes in as
// latitude,longitude to 6 decimals (about 10 cm), never as an address the maps app would look up
// again. A destination URL replaces a route in progress, so only a place the driver picked uses it.
//
// Walking (the parked card's "Walk back"): Apple Maps and Google Maps walk; Waze only drives, so
// any app without a walking mode falls back to Apple Maps on iPhone and Google Maps on Android.
// Pure; imports only types.
import type { LatLng } from '@/lib/geo';

import type { NavAppId } from './catalog';

export type NavPlatform = 'ios' | 'android';
export type TravelMode = 'driving' | 'walking';

/** 6 decimals; a value that rounds to zero reads "0.000000", never "-0.000000". */
const fixed6 = (n: number): string => {
  const s = n.toFixed(6);
  return /^-0\.0+$/.test(s) ? s.slice(1) : s;
};

/** The point as the URLs carry it, or null when it is not a real point on the globe. */
export function pointParam(point: LatLng): string | null {
  const { lat, lng } = point;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `${fixed6(lat)},${fixed6(lng)}`;
}

type Builder = (ll: string) => string;
type AppUrls = Partial<Record<NavPlatform, Partial<Record<TravelMode, Builder>>>>;

const URLS: Partial<Record<NavAppId, AppUrls>> = {
  apple_maps: {
    ios: { driving: (ll) => `maps://?daddr=${ll}&dirflg=d`, walking: (ll) => `maps://?daddr=${ll}&dirflg=w` },
  },
  google_maps: {
    ios: { driving: (ll) => `comgooglemaps://?daddr=${ll}&directionsmode=driving`, walking: (ll) => `comgooglemaps://?daddr=${ll}&directionsmode=walking` },
    android: { driving: (ll) => `google.navigation:q=${ll}&mode=d`, walking: (ll) => `google.navigation:q=${ll}&mode=w` },
  },
  waze: {
    ios: { driving: (ll) => `waze://?ll=${ll}&navigate=yes` },
    android: { driving: (ll) => `waze://?ll=${ll}&navigate=yes` },
  },
};

/** The app walking directions fall back to on each platform. */
export const WALKING_FALLBACK: Record<NavPlatform, NavAppId> = { ios: 'apple_maps', android: 'google_maps' };

const builder = (appId: NavAppId | null | undefined, platform: NavPlatform, mode: TravelMode): Builder | null =>
  (typeof appId === 'string' && Object.prototype.hasOwnProperty.call(URLS, appId) ? URLS[appId]?.[platform]?.[mode] : undefined) ?? null;

/** Whether the app takes a destination on this platform (driving directions to a point). */
export const takesDestination = (appId: NavAppId | null | undefined, platform: NavPlatform): boolean => builder(appId, platform, 'driving') !== null;

/** The URL that opens the app with `mode` directions to `point`, or null when it has none (or the point is not real). */
export function destinationUrl(appId: NavAppId | null | undefined, platform: NavPlatform, point: LatLng, mode: TravelMode): string | null {
  const build = builder(appId, platform, mode);
  const ll = pointParam(point);
  return build === null || ll === null ? null : build(ll);
}

/** Driving directions to `point` in the app, or null when the app takes no destination here. */
export const drivingUrl = (appId: NavAppId | null | undefined, platform: NavPlatform, point: LatLng): string | null => destinationUrl(appId, platform, point, 'driving');

/**
 * Walking directions to `point`: in the app when it walks, else in Apple Maps (iPhone) or Google
 * Maps (Android). Null only when the point is not a real point.
 */
export function walkingUrl(appId: NavAppId | null | undefined, platform: NavPlatform, point: LatLng): string | null {
  return destinationUrl(builder(appId, platform, 'walking') !== null ? appId : WALKING_FALLBACK[platform], platform, point, 'walking');
}
