/**
 * The US state the phone is in, for Permit mode's hour targets: the phone's own reverse geocoder at
 * the position the phone already has (never a prompt, never a GPS fix of its own). Null when there
 * is no position or no permission, outside the US, or on any failure. Never throws.
 */
import type { LatLng } from '@/lib/geo';
import { reverseGeocode } from '@/lib/phoneGeocoder';
import { lastKnownPlace } from '@/ui/sky/ports';

import { stateFromRegion, type PermitState } from './states';

/** What the geocoder answers that this reads. */
export interface GeoRegion {
  isoCountryCode?: string | null;
  region?: string | null;
}

export type ReverseGeocode = (point: LatLng) => Promise<readonly GeoRegion[]>;

/** The phone's reverse geocode (`@/lib/phoneGeocoder`: Apple's on iPhone, Android's own on Android). */
const phoneGeocode: ReverseGeocode = (point) => reverseGeocode(point);

/** The state at a point: the geocoder's region (a postal code on an iPhone, a full name on Android), in the US only. */
export async function stateAt(point: LatLng, geocode: ReverseGeocode = phoneGeocode): Promise<PermitState | null> {
  try {
    const first = (await geocode(point))[0];
    if (!first || (first.isoCountryCode ?? '').toUpperCase() !== 'US') return null;
    return stateFromRegion(first.region);
  } catch {
    return null;
  }
}

export interface StatePorts {
  position: () => Promise<LatLng | null>;
  geocode: ReverseGeocode;
}

export const phoneStatePorts: StatePorts = { position: lastKnownPlace, geocode: phoneGeocode };

/** The state where the phone is now, from the position it already has; null when unknown. */
export async function detectState(ports: StatePorts = phoneStatePorts): Promise<PermitState | null> {
  try {
    const at = await ports.position();
    return at === null ? null : await stateAt(at, ports.geocode);
  } catch {
    return null;
  }
}
