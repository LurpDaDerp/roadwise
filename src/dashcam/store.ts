// The DashPal tables (SQLite V5, plan §3.6, §7.5): events persisted before they are acknowledged,
// per-boot clock offsets and floors, and per-drive coverage. Reads and writes SQLite only; the link
// serialises its own calls, so nothing here takes a transaction (the driver allows one at a time and
// the recorder and the sync runner hold theirs).
import type { Db } from '@/data/db/driver';
import { asNumber, asNumberOrNull } from '@/data/db/row';

/** A boot key above 2^32 is a local collision generation of the wire boot id (see `SCHEMA_V5`). */
export const BOOT_GENERATION = 2 ** 32;
export const wireBootId = (bootKey: number): number => bootKey % BOOT_GENERATION;

/** Unattached events (no drive) older than this are pruned in the foreground jobs. */
export const UNATTACHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface BootRow {
  dashcamId: string;
  bootKey: number;
  offsetMs: number | null;
  rttMs: number | null;
  floorSeq: number;
  maxSeq: number;
}

export interface NewDashcamEvent {
  dashcamId: string;
  bootKey: number;
  seq: number;
  id: string;
  ev: number;
  name: string;
  tier: number;
  audible: boolean;
  detail: number;
  tMs: number;
  durDs: number;
  value: number;
  /** cache only: the fire time and the condition start, from the offset known at receipt */
  atMs: number | null;
  startedAtMs: number | null;
  receivedAtMs: number;
}

function bootRow(row: Record<string, unknown>): BootRow {
  return {
    dashcamId: String(row.dashcam_id),
    bootKey: asNumber(row, 'boot_id'),
    offsetMs: asNumberOrNull(row, 'offset_ms'),
    rttMs: asNumberOrNull(row, 'rtt_ms'),
    floorSeq: asNumber(row, 'floor_seq'),
    maxSeq: asNumber(row, 'max_seq'),
  };
}

const BOOT_COLUMNS = 'dashcam_id, boot_id, offset_ms, rtt_ms, floor_seq, max_seq';

export function createDashcamStore(db: Db) {
  async function getBoot(dashcamId: string, bootKey: number): Promise<BootRow | null> {
    const { rows } = await db.execute(`SELECT ${BOOT_COLUMNS} FROM dashcam_boots WHERE dashcam_id = ? AND boot_id = ?`, [dashcamId, bootKey]);
    return rows[0] ? bootRow(rows[0]) : null;
  }

  return {
    getBoot,

    /** The newest local generation stored for this wire boot id, or null when the boot is new to the phone. */
    async latestBoot(dashcamId: string, wireId: number): Promise<BootRow | null> {
      const { rows } = await db.execute(
        `SELECT ${BOOT_COLUMNS} FROM dashcam_boots WHERE dashcam_id = ? AND boot_id % ? = ? ORDER BY boot_id DESC LIMIT 1`,
        [dashcamId, BOOT_GENERATION, wireId]
      );
      return rows[0] ? bootRow(rows[0]) : null;
    },

    /** Create the boot row if missing and raise its floor (never lowers it). */
    async ensureBoot(dashcamId: string, bootKey: number, floorSeq: number): Promise<BootRow> {
      await db.execute('INSERT OR IGNORE INTO dashcam_boots (dashcam_id, boot_id, floor_seq) VALUES (?, ?, ?)', [dashcamId, bootKey, floorSeq]);
      await db.execute('UPDATE dashcam_boots SET floor_seq = MAX(floor_seq, ?) WHERE dashcam_id = ? AND boot_id = ?', [floorSeq, dashcamId, bootKey]);
      const row = await getBoot(dashcamId, bootKey);
      if (!row) throw new Error('dashcam boot row missing after insert');
      return row;
    },

    /** Keep this offset only when it is the first or its round trip is shorter. True when kept. */
    async offerOffset(dashcamId: string, bootKey: number, offsetMs: number, rttMs: number): Promise<boolean> {
      const { changes } = await db.execute(
        'UPDATE dashcam_boots SET offset_ms = ?, rtt_ms = ? WHERE dashcam_id = ? AND boot_id = ? AND (rtt_ms IS NULL OR rtt_ms > ?)',
        [Math.round(offsetMs), Math.max(0, Math.round(rttMs)), dashcamId, bootKey, Math.max(0, Math.round(rttMs))]
      );
      return changes > 0;
    },

    /** INSERT OR IGNORE on (dashcam, boot, seq). True when this call stored it (false: already stored). */
    async insertEvent(e: NewDashcamEvent): Promise<boolean> {
      const { changes } = await db.execute(
        `INSERT OR IGNORE INTO dashcam_events
           (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, at_ms, started_at_ms, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.dashcamId,
          e.bootKey,
          e.seq,
          e.id,
          e.ev,
          e.name,
          e.tier,
          e.audible ? 1 : 0,
          e.detail,
          e.tMs,
          e.durDs,
          e.value,
          e.atMs,
          e.startedAtMs,
          e.receivedAtMs,
        ]
      );
      await db.execute('UPDATE dashcam_boots SET max_seq = MAX(max_seq, ?) WHERE dashcam_id = ? AND boot_id = ?', [e.seq, e.dashcamId, e.bootKey]);
      return changes > 0;
    },

    /**
     * The phone's cursor for a boot: the lowest seq ≥ `floorSeq` not yet stored. Every seq below it
     * (and at or above the floor) is persisted; gaps below the floor are gone from the dashcam.
     */
    async cursor(dashcamId: string, bootKey: number, floorSeq: number): Promise<number> {
      const { rows } = await db.execute(
        `SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM dashcam_events WHERE dashcam_id = ? AND boot_id = ? AND seq = ?) THEN ?
           ELSE (SELECT MIN(e.seq) + 1 FROM dashcam_events e
                 WHERE e.dashcam_id = ? AND e.boot_id = ? AND e.seq >= ?
                   AND NOT EXISTS (SELECT 1 FROM dashcam_events n WHERE n.dashcam_id = ? AND n.boot_id = ? AND n.seq = e.seq + 1))
         END AS cursor`,
        [dashcamId, bootKey, floorSeq, floorSeq, dashcamId, bootKey, floorSeq, dashcamId, bootKey]
      );
      return asNumber(rows[0] ?? {}, 'cursor');
    },

    /** One drive row's coverage: adds the seconds; stamps the sync time when given. */
    async addCoverage(clientTripId: string, movingS: number, coveredS: number, syncedAtMs: number | null): Promise<void> {
      await db.execute(
        `INSERT INTO dashcam_coverage (client_trip_id, moving_s, covered_s, last_synced_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (client_trip_id) DO UPDATE SET
           moving_s = moving_s + excluded.moving_s,
           covered_s = covered_s + excluded.covered_s,
           last_synced_at_ms = COALESCE(excluded.last_synced_at_ms, last_synced_at_ms)`,
        [clientTripId, movingS, coveredS, syncedAtMs]
      );
    },

    async coverage(clientTripId: string): Promise<{ movingS: number; coveredS: number; lastSyncedAtMs: number | null } | null> {
      const { rows } = await db.execute('SELECT moving_s, covered_s, last_synced_at_ms FROM dashcam_coverage WHERE client_trip_id = ?', [clientTripId]);
      const row = rows[0];
      if (!row) return null;
      return { movingS: asNumber(row, 'moving_s'), coveredS: asNumber(row, 'covered_s'), lastSyncedAtMs: asNumberOrNull(row, 'last_synced_at_ms') };
    },

    /** Events no drive claimed, received before `beforeMs`. Returns how many went. */
    async pruneUnattached(beforeMs: number): Promise<number> {
      const { changes } = await db.execute('DELETE FROM dashcam_events WHERE client_trip_id IS NULL AND received_at_ms < ?', [beforeMs]);
      return changes;
    },
  };
}

export type DashcamStore = ReturnType<typeof createDashcamStore>;
