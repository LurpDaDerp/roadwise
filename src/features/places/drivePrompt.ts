/**
 * The drive recap's "Save as Home / Work / School?" question: for one drive, its end (then its
 * start) when that point is surely one of the three (`promptFor`), that slot is still empty, the
 * point isn't a saved place already, the driver hasn't said No to it and hasn't turned the question
 * off. Worked out on the phone from the drive's raw ends (never uploaded); the address comes from
 * the phone's reverse geocoder (remembered), never for a point inside a privacy zone.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { promptFor, type PromptKind, type PromptWhy } from '@/core/places/classify';
import { CLUSTER_RADIUS_M, SAVED_NEAR_M, type LearnedPlace } from '@/core/places/learn';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDataSource } from '@/data/queries/context';
import { readZones, type PrivacyZone } from '@/features/settings/privacyZones';
import { haversineMeters, type LatLng } from '@/lib/geo';

import { fetchLearned, rememberedAddress } from './learned';
import { PROMPT_DECLINED_KEY, PROMPT_OFF_KEY, readPlaces } from './model';
import { addressAt, type AddressLines } from './search';

const MAX_DECLINED = 50;

export interface DrivePrompt {
  kind: PromptKind;
  why: PromptWhy;
  /** Where the place would be saved: the learned place's centre, else the drive's own end. */
  point: LatLng;
  /** The address, or null (inside a privacy zone, or the phone couldn't name it). */
  address: AddressLines | null;
  /** The privacy zone the point lies in. */
  zone: PrivacyZone | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The drive's raw end and start, end first; none for an archived drive. */
export async function readDriveEnds(db: Db, clientTripId: string): Promise<LatLng[]> {
  const { rows } = await db.execute('SELECT start_lat, start_lng, end_lat, end_lng FROM trips WHERE client_trip_id = ?', [clientTripId]);
  const r = rows[0];
  if (!r) return [];
  const out: LatLng[] = [];
  if (finite(r.end_lat) && finite(r.end_lng)) out.push({ lat: r.end_lat, lng: r.end_lng });
  if (finite(r.start_lat) && finite(r.start_lng)) out.push({ lat: r.start_lat, lng: r.start_lng });
  return out;
}

async function readDeclined(settings: Pick<SettingsRepo, 'get'>): Promise<LatLng[]> {
  const raw = await settings.get<unknown>(PROMPT_DECLINED_KEY);
  return Array.isArray(raw) ? raw.filter((p): p is LatLng => typeof p === 'object' && p !== null && finite((p as LatLng).lat) && finite((p as LatLng).lng)) : [];
}

/** Never ask about this point again (No on the card). */
export async function declinePrompt(settings: Pick<SettingsRepo, 'get' | 'set'>, point: LatLng): Promise<void> {
  const list = await readDeclined(settings);
  await settings.set(PROMPT_DECLINED_KEY, [{ lat: Math.round(point.lat * 1e5) / 1e5, lng: Math.round(point.lng * 1e5) / 1e5 }, ...list].slice(0, MAX_DECLINED));
}

/** Whether the recap asks at all (on until Don't remind me, or the switch in Places). */
export async function readPromptOn(settings: Pick<SettingsRepo, 'get'>): Promise<boolean> {
  return (await settings.get<boolean>(PROMPT_OFF_KEY)) !== true;
}

export interface PromptInputs {
  ends: readonly LatLng[];
  learned: readonly LearnedPlace[];
  saved: readonly { kind: string; lat: number; lng: number }[];
  declined: readonly LatLng[];
  zones: readonly PrivacyZone[];
  /** The address (with the place's own name) at a point outside every zone. */
  address: (p: LatLng) => Promise<AddressLines | null>;
}

/** The question for a drive with these ends, or null. */
export async function pickPrompt(i: PromptInputs): Promise<DrivePrompt | null> {
  const near = (a: LatLng, b: LatLng, m: number) => haversineMeters(a, b) <= m;
  for (const end of i.ends) {
    if (i.saved.some((p) => near(p, end, SAVED_NEAR_M)) || i.declined.some((d) => near(d, end, SAVED_NEAR_M))) continue;
    const learned = i.learned.find((l) => near(l.center, end, CLUSTER_RADIUS_M)) ?? null;
    const zone = i.zones.find((z) => near(z, end, z.radiusM)) ?? null;
    const address = zone ? null : await i.address(end);
    const verdict = promptFor(learned, address?.poi ?? null);
    if (!verdict || i.saved.some((p) => p.kind === verdict.kind)) continue;
    const point = learned?.center ?? end;
    if (i.declined.some((d) => near(d, point, SAVED_NEAR_M))) continue;
    return { ...verdict, point, address, zone };
  }
  return null;
}

/** The question for `clientTripId`, read fresh. */
export async function readDrivePrompt(db: Db, client: QueryClient, now: () => number, clientTripId: string): Promise<DrivePrompt | null> {
  const settings = createSettingsRepo(db);
  if (!(await readPromptOn(settings))) return null;
  const ends = await readDriveEnds(db, clientTripId);
  if (ends.length === 0) return null;
  const [saved, declined, zones, learned] = await Promise.all([readPlaces(settings), readDeclined(settings), readZones(settings).catch(() => []), fetchLearned(client, db, now).catch(() => [])]);
  return pickPrompt({ ends, learned, saved, declined, zones, address: (p) => rememberedAddress(settings, p, addressAt) });
}

export const PROMPT_QUERY = ['places', 'prompt'] as const;

export function useDrivePrompt(clientTripId: string) {
  const { db, now } = useDataSource();
  const client = useQueryClient();
  return useQuery({ queryKey: [...PROMPT_QUERY, clientTripId], queryFn: () => readDrivePrompt(db, client, now, clientTripId), staleTime: 60_000 });
}
