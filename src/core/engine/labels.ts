// From/to labels for the drive summary (plan §5): the zone's name, else the OS reverse geocode to
// a neighbourhood or street, else null (the screen prints "Start" / "End"). Computed on the device
// and stored only locally; never uploaded.
import type { LatLng } from '@/lib/geo';

import { zoneAt, type PrivacyZone } from './privacy';

export type Geocoder = (point: LatLng) => Promise<string | null>;

/** How long one reverse geocode may take before the label is simply left empty. */
export const GEOCODE_TIMEOUT_MS = 4000;
export const MAX_LABEL_CHARS = 40;

const clip = (s: string): string => (s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS - 1)}…` : s);

/** expo-location's reverse geocode, loaded on first use. Never throws: any failure is null. */
export const expoGeocoder: Geocoder = async (point) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const results = await Location.reverseGeocodeAsync({ latitude: point.lat, longitude: point.lng });
    const first = results[0];
    if (!first) return null;
    const label = first.district ?? first.street ?? first.subregion ?? first.city ?? null;
    return label === null || label === '' ? null : clip(label);
  } catch {
    return null;
  }
};

function within<T>(ms: number, p: Promise<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** The label for one endpoint: its zone's name first, so a geocode is never made inside a zone. */
export async function labelFor(point: LatLng | null, zones: readonly PrivacyZone[], geocode: Geocoder | null): Promise<string | null> {
  if (point === null) return null;
  const zone = zoneAt(point, zones);
  if (zone !== null) return zone.name;
  if (geocode === null) return null;
  const label = await within(GEOCODE_TIMEOUT_MS, geocode(point));
  return typeof label === 'string' && label.length > 0 ? clip(label) : null;
}
