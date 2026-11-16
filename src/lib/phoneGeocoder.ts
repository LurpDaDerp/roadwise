/**
 * The phone's own geocoder, the one channel the drive labels, the spots' street names, a saved
 * place's address and Look up, and Permit mode's state all go through (one coordinate, or the typed
 * address, to the OS geocoder; nothing else).
 *
 * - **iPhone:** expo-location's `reverseGeocodeAsync` / `geocodeAsync` (Apple's geocoder), exactly
 *   as before.
 * - **Android:** drive-sense's native geocoder (`android.location.Geocoder`, Google's backend),
 *   which answers with RoadWise in the background or headless too. expo-location's Android geocoder
 *   refuses whenever the activity is behind ("Geocoder is not running"), so a drive Android
 *   finalized behind came out "Start" / "End". A phone with no geocoder at all
 *   (`Geocoder.isPresent()` false) answers nothing, and the callers fall back as they do for any
 *   empty answer (no label). An Android build without the native geocoder keeps expo-location's.
 *
 * Both answer in expo-location's shapes, and both reject on a failure (the callers already treat a
 * rejection as no answer). One call per lookup on either platform: the Android path never asks a
 * second geocoder.
 */
import { nativeGeocoder } from '@drive-sense';
import { Platform } from 'react-native';

import type { LatLng } from './geo';

/** The parts of an address the callers read (expo-location's `LocationGeocodedAddress`). */
export interface PhoneAddress {
  name?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  city?: string | null;
  district?: string | null;
  subregion?: string | null;
  region?: string | null;
  postalCode?: string | null;
  isoCountryCode?: string | null;
  country?: string | null;
}

/** A point a typed address names (expo-location's `LocationGeocodedLocation`). */
export interface PhonePoint {
  latitude: number;
  longitude: number;
}

const expoLocation = (): typeof import('expo-location') =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  require('expo-location') as typeof import('expo-location');

/** Android's native geocoder when this is an Android build that has it; null on iPhone and elsewhere. */
const android = () => (Platform.OS === 'android' ? nativeGeocoder() : null);

/** The addresses at a point, best first. Empty when there are none (or no geocoder on this phone). Rejects on a failure. */
export async function reverseGeocode(point: LatLng): Promise<PhoneAddress[]> {
  const native = android();
  if (native) return (await native.reverse(point.lat, point.lng)) ?? [];
  return expoLocation().reverseGeocodeAsync({ latitude: point.lat, longitude: point.lng });
}

/** The points a typed address names, best first. Empty when it names none. Rejects on a failure. */
export async function forwardGeocode(query: string): Promise<PhonePoint[]> {
  const native = android();
  if (native) return (await native.forward(query)) ?? [];
  return expoLocation().geocodeAsync(query);
}
