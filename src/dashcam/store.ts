// The DashPal tables (SQLite V5–V6, plan §3.6, §7.5): events persisted before they are acknowledged,
// per-boot clock offsets and floors, and per-drive coverage. Reads and writes SQLite only; the link
// serialises its own calls, so nothing here takes a transaction (the driver allows one at a time and
// the recorder and the sync runner hold theirs).
import type { Db } from '@/data/db/driver';
import { asNumber, asNumberOrNull } from '@/data/db/row';

/** A boot key above 2^32 is a local collision generation of the wire boot id (see `SCHEMA_V5`). */
export const BOOT_GENERATION = 2 ** 32;
export const wireBootId = (bootKey: number): number => bootKey % BOOT_GENERATION;

/** Unattached events (no drive claimed them, ignored ones included) older than this are pruned in the foreground jobs. */
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
  /**
   * It arrived while no drive was open: stored only as a delivery record (the cursor needs every
   * seq), never claimed by a drive. Set by the first copy only; a replay never changes it.
   */
  ignored?: boolean;
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

/**
 * The cursor as one SQL expression over a boot's dashcam id, boot key and floor (column
 * expressions, no parameters): the floor when its seq is not stored, else one past the end of the
 * stored run that starts there.
 */
const cursorSql = (cam: string, boot: string, floor: string): string => `CASE
  WHEN NOT EXISTS (SELECT 1 FROM dashcam_events x WHERE x.dashcam_id = ${cam} AND x.boot_id = ${boot} AND x.seq = ${floor}) THEN ${floor}
  ELSE (SELECT MIN(e.seq) + 1 FROM dashcam_events e
        WHERE e.dashcam_id = ${cam} AND e.boot_id = ${boot} AND e.seq >= ${floor}
          AND NOT EXISTS (SELECT 1 FROM dashcam_events n WHERE n.dashcam_id = e.dashcam_id AND n.boot_id = e.boot_id AND n.seq = e.seq + 1))
END`;

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

    /**
     * INSERT OR IGNORE on (dashcam, boot, seq). True when this call stored it (false: already
     * stored, its first copy kept as it was, or below the boot's stored floor: every seq there is
     * stored, gone from the dashcam or pruned, so a re-sent pruned event never comes back as new).
     */
    async insertEvent(e: NewDashcamEvent): Promise<boolean> {
      const { changes } = await db.execute(
        `INSERT OR IGNORE INTO dashcam_events
           (dashcam_id, boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, at_ms, started_at_ms, received_at_ms, ignored)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM dashcam_boots b WHERE b.dashcam_id = ? AND b.boot_id = ? AND b.floor_seq > ?)`,
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
          e.ignored ? 1 : 0,
          e.dashcamId,
          e.bootKey,
          e.seq,
        ]
      );
      await db.execute('UPDATE dashcam_boots SET max_seq = MAX(max_seq, ?) WHERE dashcam_id = ? AND boot_id = ?', [e.seq, e.dashcamId, e.bootKey]);
      return changes > 0;
    },

    /**
     * The phone's cursor for a boot: the lowest seq at or above the floor not yet stored, the floor
     * being the higher of `floorSeq` and the boot's stored floor (the prune may have raised it under
     * a live link). Every seq from the floor up to the cursor is persisted; every seq below the
     * floor is stored, gone from the dashcam or pruned, so the cursor never moves backwards.
     */
    async cursor(dashcamId: string, bootKey: number, floorSeq: number): Promise<number> {
      const stored = await getBoot(dashcamId, bootKey);
      const floor = Math.max(floorSeq, stored?.floorSeq ?? floorSeq);
      const { rows } = await db.execute(`SELECT ${cursorSql('b.cam', 'b.boot', 'b.floor')} AS cursor FROM (SELECT ? AS cam, ? AS boot, ? AS floor) b`, [
        dashcamId,
        bootKey,
        floor,
      ]);
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

    /**
     * Events no drive claimed, received before `beforeMs`, below their boot's cursor. Returns how
     * many went. Each boot holding such events first has its floor raised to its cursor, so the
     * deleted seqs sit below the floor: the cursor stays where it was (the link stays synced and no
     * RESUME asks for them again) and a re-sent copy is not stored again. An old event above a gap
     * waits until the gap fills (the next RESUME asks for it), then goes at the next prune.
     */
    async pruneUnattached(beforeMs: number): Promise<number> {
      await db.execute(
        `UPDATE dashcam_boots
           SET floor_seq = ${cursorSql('dashcam_boots.dashcam_id', 'dashcam_boots.boot_id', 'dashcam_boots.floor_seq')}
         WHERE EXISTS (SELECT 1 FROM dashcam_events p
                       WHERE p.dashcam_id = dashcam_boots.dashcam_id AND p.boot_id = dashcam_boots.boot_id
                         AND p.client_trip_id IS NULL AND p.received_at_ms < ?)`,
        [beforeMs]
      );
      const { changes } = await db.execute(
        `DELETE FROM dashcam_events
         WHERE client_trip_id IS NULL AND received_at_ms < ?
           AND seq < COALESCE((SELECT b.floor_seq FROM dashcam_boots b
                               WHERE b.dashcam_id = dashcam_events.dashcam_id AND b.boot_id = dashcam_events.boot_id), seq + 1)`,
        [beforeMs]
      );
      return changes;
    },
  };
}

export type DashcamStore = ReturnType<typeof createDashcamStore>;
