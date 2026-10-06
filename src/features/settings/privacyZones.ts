/**
 * Privacy zones (plan §1 decision 6, §10): up to 3 circles, 200–800 m, stored only on this phone
 * under `privacy.zones`. The drive pipeline trims routes and event dots inside them before anything
 * is uploaded, so the server, share cards and heat maps never see where a zone is.
 */
import type { SettingsRepo } from '@/data/db/settings';

export const PRIVACY_ZONES_KEY = 'privacy.zones';
export const MAX_ZONES = 3;
export const MIN_RADIUS_M = 200;
export const MAX_RADIUS_M = 800;
export const RADIUS_STEP_M = 50;
export const DEFAULT_RADIUS_M = 300;
export const ZONE_NAME_MAX = 20;

export interface PrivacyZone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export type ZoneProblem = 'name_empty' | 'name_long' | 'radius' | 'center' | 'too_many';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** What is wrong with one zone, or null. */
export function zoneProblem(zone: Pick<PrivacyZone, 'name' | 'lat' | 'lng' | 'radiusM'>): ZoneProblem | null {
  const name = zone.name.trim();
  if (name.length === 0) return 'name_empty';
  if (name.length > ZONE_NAME_MAX) return 'name_long';
  if (!finite(zone.radiusM) || zone.radiusM < MIN_RADIUS_M || zone.radiusM > MAX_RADIUS_M) return 'radius';
  if (!finite(zone.lat) || !finite(zone.lng) || Math.abs(zone.lat) > 90 || Math.abs(zone.lng) > 180) return 'center';
  return null;
}

/** What is wrong with the whole list, or null. */
export function zonesProblem(zones: readonly PrivacyZone[]): ZoneProblem | null {
  if (zones.length > MAX_ZONES) return 'too_many';
  for (const z of zones) {
    const p = zoneProblem(z);
    if (p) return p;
  }
  return null;
}

/** The radius moved one step and kept in bounds. */
export function stepRadius(radiusM: number, dir: -1 | 1): number {
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radiusM + dir * RADIUS_STEP_M));
}

function isZone(v: unknown): v is PrivacyZone {
  if (typeof v !== 'object' || v === null) return false;
  const z = v as Record<string, unknown>;
  return (
    typeof z.id === 'string' &&
    typeof z.name === 'string' &&
    zoneProblem({ name: z.name, lat: z.lat as number, lng: z.lng as number, radiusM: z.radiusM as number }) === null
  );
}

/** The stored zones; anything malformed is skipped, never fatal. */
export async function readZones(settings: Pick<SettingsRepo, 'get'>): Promise<PrivacyZone[]> {
  const raw = await settings.get<unknown>(PRIVACY_ZONES_KEY);
  return Array.isArray(raw) ? raw.filter(isZone).slice(0, MAX_ZONES) : [];
}

/** Saves the list, names trimmed. Rejects (writing nothing) when the list breaks a rule. */
export async function writeZones(settings: Pick<SettingsRepo, 'set'>, zones: readonly PrivacyZone[]): Promise<void> {
  const problem = zonesProblem(zones);
  if (problem) throw new Error(`privacy zones: ${problem}`);
  await settings.set(
    PRIVACY_ZONES_KEY,
    zones.map((z) => ({ id: z.id, name: z.name.trim(), lat: z.lat, lng: z.lng, radiusM: z.radiusM }))
  );
}

/** A new zone id; unique enough for three local rows. */
export function newZoneId(now: number = Date.now()): string {
  return `zone-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
