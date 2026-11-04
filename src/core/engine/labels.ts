// From/to labels for the drive summary (plan §5): the saved place the end is (an exact match,
// `core/places/match.ts`), else the zone's name, else the OS reverse geocode to a neighbourhood or
// street, else null (the screen prints "Start" / "End"). Computed on the device and stored only
// locally; never uploaded. Nothing inside a privacy zone is ever geocoded.
import { matchPlace, type AddressParts, type MatchablePlace } from '@/core/places/match';
import type { LatLng } from '@/lib/geo';

import { zoneAt, type PrivacyZone } from './privacy';

/** One reverse geocode's answer: the label text and the address parts it read (rule 3 of the place match). */
export interface GeocodedAddress extends AddressParts {
  label: string | null;
}

/** A reverse geocoder: the label text alone (the spots' street names), or the text with its address parts. */
export type Geocoder = (point: LatLng) => Promise<string | GeocodedAddress | null>;

/** How long one reverse geocode may take before the label is simply left empty. */
export const GEOCODE_TIMEOUT_MS = 4000;
export const MAX_LABEL_CHARS = 40;

const clip = (s: string): string => (s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS - 1)}…` : s);

const partOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * expo-location's reverse geocode, loaded on first use: the label (`district ?? street ?? subregion
 * ?? city`) and the house number and street. Never throws: any failure is null.
 */
export const expoGeocoder: Geocoder = async (point) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const results = await Location.reverseGeocodeAsync({ latitude: point.lat, longitude: point.lng });
    const first = results[0];
    if (!first) return null;
    const label = first.district ?? first.street ?? first.subregion ?? first.city ?? null;
    return { label: label === null || label === '' ? null : clip(label), number: partOf(first.streetNumber), street: partOf(first.street) };
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

/**
 * Where the drive started, for its "from" label and its stored start: the parked spot the drive
 * started from when its start came from the motion history (`startPlace`), else its first recorded fix.
 */
export function startPoint(session: { startPlace: LatLng | null; firstFix: LatLng | null }): LatLng | null {
  return session.startPlace ?? session.firstFix;
}

/** A geocoder's answer as its label text (clipped) and its address parts. */
function readAnswer(answer: unknown): { label: string | null; address: AddressParts | null } {
  if (typeof answer === 'string') return { label: answer.length > 0 ? clip(answer) : null, address: null };
  if (typeof answer !== 'object' || answer === null) return { label: null, address: null };
  const a = answer as Partial<GeocodedAddress>;
  const label = typeof a.label === 'string' && a.label.length > 0 ? clip(a.label) : null;
  return { label, address: { number: partOf(a.number), street: partOf(a.street) } };
}

/** One geocode within `GEOCODE_TIMEOUT_MS`; a late or failed one is nothing. */
async function geocodeWithin(point: LatLng, geocode: Geocoder): Promise<{ label: string | null; address: AddressParts | null }> {
  let pending: Promise<unknown>;
  try {
    pending = geocode(point);
  } catch {
    return { label: null, address: null };
  }
  return readAnswer(await within(GEOCODE_TIMEOUT_MS, pending));
}

/** The label for one endpoint: its zone's name first, so a geocode is never made inside a zone. */
export async function labelFor(point: LatLng | null, zones: readonly PrivacyZone[], geocode: Geocoder | null): Promise<string | null> {
  if (point === null) return null;
  const zone = zoneAt(point, zones);
  if (zone !== null) return zone.name;
  if (geocode === null) return null;
  return (await geocodeWithin(point, geocode)).label;
}

/** A saved place as the labels read it: who it is, where, its address and where the driver usually parks there. */
export type LabelPlace = MatchablePlace & { name: string; anchor?: LatLng | null };

/** The label of an end inside a saved place's privacy zone that is not that place (a neighbour's house): "Near Home". */
export const nearLabel = (zoneName: string): string => clip(`Near ${zoneName}`);

/** An end's label and the saved place it is (`from_place` / `to_place`), or null. */
export interface EndLabel {
  label: string | null;
  placeId: string | null;
}

const anchorsOf = (places: readonly LabelPlace[]): Map<string, LatLng> => {
  const out = new Map<string, LatLng>();
  for (const p of places) if (p.anchor) out.set(p.id, p.anchor);
  return out;
};

/**
 * One end's label and place (`core/places/match.ts` for the rules):
 * - inside a privacy zone nothing is geocoded: the saved place it is by rules 1, 2 or 4 (the
 *   place's name), else "Near {zone}" for a saved place's zone, else the zone's own name;
 * - elsewhere, a sure match (rule 1 or 2) needs no geocode; otherwise one geocode gives the label
 *   text and the address, and a match by rule 3 or 4 labels with the place's name, else the
 *   geocoder's text (null without one).
 */
export async function endLabel(point: LatLng | null, zones: readonly PrivacyZone[], places: readonly LabelPlace[], geocode: Geocoder | null): Promise<EndLabel> {
  if (point === null) return { label: null, placeId: null };
  const anchors = anchorsOf(places);
  const named = (p: LabelPlace): EndLabel => ({ label: clip(p.name), placeId: p.id });
  const zone = zoneAt(point, zones);
  if (zone !== null) {
    const place = matchPlace(point, places, { anchors });
    if (place !== null) return named(place);
    return { label: zone.placeId !== undefined ? nearLabel(zone.name) : zone.name, placeId: null };
  }
  const sure = matchPlace(point, places, { anchors, sureOnly: true });
  if (sure !== null) return named(sure);
  const answer = geocode === null ? { label: null, address: null } : await geocodeWithin(point, geocode);
  const place = matchPlace(point, places, { anchors, address: answer.address });
  return place !== null ? named(place) : { label: answer.label, placeId: null };
}
