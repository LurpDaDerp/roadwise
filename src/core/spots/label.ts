/**
 * A spot's place name (spots.md §5): the street from the phone's reverse geocoder (Apple's or
 * Google's, the same channel the drive labels use), never inside a privacy zone. One coordinate
 * goes to the OS geocoder, nothing else.
 */
import { labelFor, MAX_LABEL_CHARS, type Geocoder } from '@/core/engine/labels';
import { zoneAt, type PrivacyZone } from '@/core/engine/privacy';
import type { LatLng } from '@/lib/geo';

export type { Geocoder } from '@/core/engine/labels';

const clip = (s: string): string => (s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS - 1)}…` : s);

/** expo-location's reverse geocode, street first ("Dexter Ave N"). Never throws: any failure is null. */
export const streetGeocoder: Geocoder = async (point) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const results = await Location.reverseGeocodeAsync({ latitude: point.lat, longitude: point.lng });
    const first = results[0];
    if (!first) return null;
    const label = first.street ?? first.name ?? first.district ?? first.city ?? null;
    return label === null || label.trim() === '' ? null : clip(label.trim());
  } catch {
    return null;
  }
};

/**
 * The place name for a spot's pin: null inside a zone (no geocode is made there), else the
 * geocoder's answer within the drive labels' timeout, clipped; null when it has none.
 */
export async function spotLabel(pin: LatLng, zones: readonly PrivacyZone[], geocode: Geocoder | null = streetGeocoder): Promise<string | null> {
  if (zoneAt(pin, zones) !== null || geocode === null) return null;
  return labelFor(pin, [], geocode);
}
