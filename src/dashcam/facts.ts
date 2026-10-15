import type { Db } from '@/data/db/driver';
import { asNumber, asNumberOrNull, asText } from '@/data/db/row';
import { mpsToMph } from '@/lib/units';

import { episodes, SPEED_NEAR_MS, SYNCED_WITHIN_MS, type EpisodeEvent } from './episodes';
import { asPaired, PAIRED_KEY } from './keys';

/**
 * What a finished drive learned from the DashPal dashcam: the seconds it watched the driver, and
 * the very dangerous episodes (eyes closed, eyes off the road with no return) it saw. Finalize turns
 * the candidates into scored events and the seconds into the DashPal drive flag. This module reads
 * SQLite only: it never imports the BLE transport or link, so finalize stays usable in recovery,
 * headless boots and tests.
 */
export interface DashcamCandidate {
  /** lowercase v4 uuid of the episode's first event */
  id: string;
  kind: 'eyes_off' | 'drowsy';
  /** epoch ms, when the episode's condition started */
  startedAt: number;
  durationS: number;
  /** phone GPS speed near the episode, from a row with a valid fix; null when unknown */
  speedMph: number | null;
}

export interface DashcamTripFacts {
  /** lowercase hex identity MAC of the paired dashcam, or null when it never covered the drive */
  dashcamId: string | null;
  /** seconds of the drive moving at 5 mph or more */
  movingS: number;
  /** of those, seconds the dashcam watched a live face on this phone's primary link */
  coveredS: number;
  /** the phone had every dashcam event persisted within 30 s of the drive's end */
  synced: boolean;
  events: DashcamCandidate[];
}

interface SpeedRow {
  ts?: unknown;
  speed?: unknown;
  gnssValid?: unknown;
}

/** The speed (mph) of the valid-fix row nearest `at` within ±2 s, or null. */
async function speedNear(db: Db, clientTripId: string, at: number): Promise<number | null> {
  const { rows } = await db.execute('SELECT ts, row_json FROM samples WHERE client_trip_id = ? AND ts BETWEEN ? AND ?', [
    clientTripId,
    at - SPEED_NEAR_MS,
    at + SPEED_NEAR_MS,
  ]);
  let best: { gap: number; mps: number } | null = null;
  for (const row of rows) {
    let parsed: SpeedRow;
    try {
      parsed = JSON.parse(asText(row, 'row_json')) as SpeedRow;
    } catch {
      continue;
    }
    if (parsed.gnssValid !== true || typeof parsed.speed !== 'number' || !Number.isFinite(parsed.speed) || parsed.speed < 0) continue;
    const gap = Math.abs(asNumber(row, 'ts') - at);
    if (best === null || gap < best.gap) best = { gap, mps: parsed.speed };
  }
  return best === null ? null : mpsToMph(best.mps);
}

export async function loadDashcamTripFacts(
  db: Db,
  trip: { clientTripId: string; startedAt: number; endedAt: number },
): Promise<DashcamTripFacts> {
  const settings = await db.execute('SELECT value_json FROM settings WHERE key = ?', [PAIRED_KEY]);
  let paired: string | null = null;
  try {
    const raw = settings.rows[0] ? (JSON.parse(asText(settings.rows[0], 'value_json')) as unknown) : null;
    paired = asPaired(raw)?.dashcamId ?? null;
  } catch {
    paired = null;
  }

  const cov = await db.execute('SELECT moving_s, covered_s, last_synced_at_ms FROM dashcam_coverage WHERE client_trip_id = ?', [trip.clientTripId]);
  const covRow = cov.rows[0];
  const movingS = covRow ? Math.max(0, Math.round(asNumber(covRow, 'moving_s'))) : 0;
  const coveredS = covRow ? Math.min(movingS, Math.max(0, Math.round(asNumber(covRow, 'covered_s')))) : 0;
  const lastSynced = covRow ? asNumberOrNull(covRow, 'last_synced_at_ms') : null;
  const synced = lastSynced !== null && lastSynced >= trip.endedAt - SYNCED_WITHIN_MS;

  if (paired === null) return { dashcamId: null, movingS, coveredS, synced, events: [] };

  // Every event of the paired dashcam whose condition started inside the drive, by the boot's best
  // offset now; not claimed by another drive and not ignored (it arrived with no drive open). Events
  // of a boot with no offset cannot be placed. An event that arrived during the drive but started
  // before it (a replay after a reconnect) is outside the window and stays unclaimed.
  const startExpr = '(b.offset_ms + e.t_ms - e.dur_ds * 100)';
  const { rows } = await db.execute(
    `SELECT e.dashcam_id, e.boot_id, e.seq, e.id, e.ev, e.detail, e.audible, e.t_ms, e.dur_ds, b.offset_ms
       FROM dashcam_events e
       JOIN dashcam_boots b ON b.dashcam_id = e.dashcam_id AND b.boot_id = e.boot_id
      WHERE e.dashcam_id = ?
        AND b.offset_ms IS NOT NULL
        AND e.ignored = 0
        AND (e.client_trip_id IS NULL OR e.client_trip_id = ?)
        AND ${startExpr} >= ? AND ${startExpr} <= ?`,
    [paired, trip.clientTripId, trip.startedAt, trip.endedAt]
  );

  const inDrive: (EpisodeEvent & { audible: boolean; dashcamId: string; bootKey: number; seq: number })[] = rows.map((r) => {
    const offset = asNumber(r, 'offset_ms');
    const firedAt = offset + asNumber(r, 't_ms');
    return {
      id: asText(r, 'id'),
      ev: asNumber(r, 'ev'),
      detail: asNumber(r, 'detail'),
      audible: asNumber(r, 'audible') !== 0,
      firedAt,
      startedAt: firedAt - asNumber(r, 'dur_ds') * 100,
      dashcamId: asText(r, 'dashcam_id'),
      bootKey: asNumber(r, 'boot_id'),
      seq: asNumber(r, 'seq'),
    };
  });

  // Stamp them to this drive (and refresh the wall-time cache) so another drive never claims them
  // and the 7-day prune keeps them with the drive.
  for (const e of inDrive) {
    await db.execute('UPDATE dashcam_events SET client_trip_id = ?, at_ms = ?, started_at_ms = ? WHERE dashcam_id = ? AND boot_id = ? AND seq = ?', [
      trip.clientTripId,
      e.firedAt,
      e.startedAt,
      e.dashcamId,
      e.bootKey,
      e.seq,
    ]);
  }

  const events: DashcamCandidate[] = [];
  for (const ep of episodes(inDrive.filter((e) => e.audible))) {
    events.push({
      id: ep.first.id,
      kind: ep.kind,
      startedAt: ep.startedAt,
      durationS: Math.round((ep.endedAt - ep.startedAt) / 100) / 10,
      speedMph: await speedNear(db, trip.clientTripId, ep.first.firedAt),
    });
  }

  return { dashcamId: movingS > 0 ? paired : null, movingS, coveredS, synced, events };
}
