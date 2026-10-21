/**
 * `problem_spots`: the places where the same thing keeps happening on this driver's drives, derived
 * on the phone by the recompute job (`src/features/spots/recompute.ts`) and replaced whole each
 * time. Local only: never uploaded, never restored (a restore recomputes them from the drives).
 */
import type { Db } from '@/data/db/driver';
import { asEnum, asNumber, asNumberOrNull, asText, asTextOrNull, insertStatement } from '@/data/db/row';
import { SPOT_ROW_KINDS, SPOT_STATES, type NewProblemSpot, type ProblemSpotRow } from '@/data/db/types';
import { haversineMeters } from '@/lib/geo';

/** Settings key: `{ v: 1, computedAt, drives }`, written with every recompute. */
export const SPOTS_META_KEY = 'spots.meta';

/**
 * A new spot keeps an old spot's place name when the same kind's pin is within this many metres
 * (spots.md `LABEL_CARRY_M`; `src/core/spots/constants.ts` holds the same number). Kept here so the
 * store, which the wipes and the boot read, needs nothing from the spots feature.
 */
export const SPOT_LABEL_CARRY_M = 60;

export interface SpotsMeta {
  v: 1;
  /** When the spots were last computed (epoch ms). */
  computedAt: number;
  /** Scored drives the computation looked at. */
  drives: number;
}

/** The meta record, or null when absent or not one this build wrote. */
export function parseSpotsMeta(raw: unknown): SpotsMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.computedAt !== 'number' || !Number.isFinite(r.computedAt) || typeof r.drives !== 'number' || !Number.isFinite(r.drives)) return null;
  return { v: 1, computedAt: r.computedAt, drives: r.drives };
}

/** The writable columns, in schema order. Nothing outside this list can reach the SQL. */
const COLUMNS = [
  'id',
  'kind',
  'state',
  'lat',
  'lng',
  'heading_deg',
  'segment',
  'limit_mph',
  'hits',
  'passes',
  'recent_hits',
  'recent_passes',
  'rate',
  'clean_streak',
  'clean_needed',
  'last_hit_at',
  'last_hit_trip',
  'last_pass_at',
  'cleared_at',
  'rank',
  'label',
  'label_at',
  'computed_at',
] as const;

export function toProblemSpotRow(row: Record<string, unknown>): ProblemSpotRow {
  return {
    id: asText(row, 'id'),
    kind: asEnum(row, 'kind', SPOT_ROW_KINDS),
    state: asEnum(row, 'state', SPOT_STATES),
    lat: asNumber(row, 'lat'),
    lng: asNumber(row, 'lng'),
    heading_deg: asNumber(row, 'heading_deg'),
    segment: asText(row, 'segment'),
    limit_mph: asNumberOrNull(row, 'limit_mph'),
    hits: asNumber(row, 'hits'),
    passes: asNumber(row, 'passes'),
    recent_hits: asNumber(row, 'recent_hits'),
    recent_passes: asNumber(row, 'recent_passes'),
    rate: asNumber(row, 'rate'),
    clean_streak: asNumber(row, 'clean_streak'),
    clean_needed: asNumber(row, 'clean_needed'),
    last_hit_at: asNumber(row, 'last_hit_at'),
    last_hit_trip: asText(row, 'last_hit_trip'),
    last_pass_at: asNumber(row, 'last_pass_at'),
    cleared_at: asNumberOrNull(row, 'cleared_at'),
    rank: asNumber(row, 'rank'),
    label: asTextOrNull(row, 'label'),
    label_at: asNumberOrNull(row, 'label_at'),
    computed_at: asNumber(row, 'computed_at'),
  };
}

/** Active first by rank, then cleared; ties by id. */
const LIST_SQL = "SELECT * FROM problem_spots ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, rank ASC, id ASC";

interface OldLabel {
  kind: string;
  lat: number;
  lng: number;
  label: string | null;
  labelAt: number;
}

/** The label of the nearest old spot of the same kind within `SPOT_LABEL_CARRY_M` that has one, or none. */
function carriedLabel(spot: NewProblemSpot, old: readonly OldLabel[]): { label: string | null; label_at: number | null } {
  let best: OldLabel | null = null;
  let bestM = Infinity;
  for (const o of old) {
    if (o.kind !== spot.kind) continue;
    const m = haversineMeters({ lat: o.lat, lng: o.lng }, { lat: spot.lat, lng: spot.lng });
    if (m <= SPOT_LABEL_CARRY_M && m < bestM) {
      best = o;
      bestM = m;
    }
  }
  return best === null ? { label: null, label_at: null } : { label: best.label, label_at: best.labelAt };
}

export function createSpotsRepo(db: Db) {
  return {
    /** Active first by rank, then cleared; ties by id. */
    async list(on: Db = db): Promise<ProblemSpotRow[]> {
      const { rows } = await on.execute(LIST_SQL);
      return rows.map(toProblemSpotRow);
    },

    /**
     * Replace every spot, in one transaction: write nothing (false) when a drive a spot links to is
     * gone (a wipe raced the recompute); else every old row goes, each new one keeps the label of the
     * nearest old spot of the same kind within `SPOT_LABEL_CARRY_M` that had one (an old label may be
     * null: "tried, nothing found"), and the meta record is written. True when written.
     */
    replaceAll(rows: readonly NewProblemSpot[], meta: { computedAt: number; drives: number }, guardTrips: readonly string[]): Promise<boolean> {
      return db.transaction(async (tx) => {
        for (const id of new Set(guardTrips)) {
          const { rows: found } = await tx.execute('SELECT 1 FROM trips WHERE client_trip_id = ?', [id]);
          if (found.length === 0) return false;
        }
        const { rows: oldRows } = await tx.execute('SELECT kind, lat, lng, label, label_at FROM problem_spots WHERE label_at IS NOT NULL');
        const old: OldLabel[] = oldRows.map((r) => ({
          kind: asText(r, 'kind'),
          lat: asNumber(r, 'lat'),
          lng: asNumber(r, 'lng'),
          label: asTextOrNull(r, 'label'),
          labelAt: asNumber(r, 'label_at'),
        }));
        await tx.execute('DELETE FROM problem_spots');
        for (const spot of rows) {
          const { sql, params } = insertStatement('problem_spots', COLUMNS, { ...spot, ...carriedLabel(spot, old), computed_at: meta.computedAt });
          await tx.execute(sql, params);
        }
        const value: SpotsMeta = { v: 1, computedAt: meta.computedAt, drives: meta.drives };
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [SPOTS_META_KEY, JSON.stringify(value)]);
        return true;
      });
    },

    /** Set a spot's place name (null: looked up, nothing found) and when; a spot that is gone is a no-op. */
    async setLabel(id: string, label: string | null, at: number): Promise<void> {
      await db.execute('UPDATE problem_spots SET label = ?, label_at = ? WHERE id = ?', [label, at, id]);
    },
  };
}

export type SpotsRepo = ReturnType<typeof createSpotsRepo>;
