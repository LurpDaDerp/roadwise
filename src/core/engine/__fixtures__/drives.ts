// Synthetic drives and finalize deps shared by the recorder and recovery suites. Lives outside
// `__tests__/` because Jest's default `testMatch` treats every file in there as a suite.
import * as scoring from '@scoring';
import { T0, row } from '@/core/detectors/__fixtures__/rows';
import type { FinalizeDeps } from '@/core/engine/finalize';
import type { FeatureRow } from '@/core/engine/types';
import type { Db } from '@/data/db';

export const TZ = 'America/Los_Angeles';
/** Standard gravity, m/s²: the GNSS Δspeed a brake must show for the harsh detector to agree. */
export const G = 9.80665;
/** m/s the drive cruises at: 10 m/s east from San Francisco, ten metres per row. */
export const SPEED = 10;

const SF = { lat: 37.7749, lng: -122.4194 };
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((SF.lat * Math.PI) / 180);

export interface DriveOptions {
  /** Row index of a 0.35 g brake the GNSS agrees with: that row is 0.25 g slower than the one before, held for three rows. */
  brakeAt?: number;
  /** Cruise speed, m/s. */
  speed?: number;
  /** epoch ms of row 0. */
  t0?: number;
}

/**
 * `n` rows at 1 Hz driving east at `speed`, the position integrated from it, with a little IMU
 * noise (so the IMU counts as present) and every 50th fix lost (still grade A). Long enough
 * (≥ 120 rows) the drive clears both `MIN_SCORED_*` thresholds and scores.
 */
export function drive(n: number, opts: DriveOptions = {}): FeatureRow[] {
  const t0 = opts.t0 ?? T0;
  const cruise = opts.speed ?? SPEED;
  const brake = opts.brakeAt ?? -1;
  const slow = cruise - 0.25 * G;
  const rows: FeatureRow[] = [];
  let lng = SF.lng;
  for (let i = 0; i < n; i += 1) {
    const braking = brake >= 0 && i >= brake && i < brake + 3;
    const speed = braking ? slow : cruise;
    rows.push(
      row({
        ts: t0 + i * 1000,
        lat: SF.lat,
        lng,
        speed,
        gnssValid: i % 50 !== 25,
        aLonMax: 0.02,
        aLonMin: i === brake ? -0.35 : -0.02,
      })
    );
    lng += speed / M_PER_DEG_LNG;
  }
  return rows;
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** Lowercase hex SHA-256 over UTF-8, what `src/lib/hash` does with expo-crypto on device. */
export const sha256 = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** The finalizer's deps over `db`, with the trace files kept in memory. */
export function finalizeDeps(
  db: Db,
  now: () => number
): { deps: FinalizeDeps; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    deps: {
      db,
      scoring,
      tz: TZ,
      fs: {
        writeGzip: async (path, bytes) => {
          files.set(path, bytes);
        },
      },
      hash: { sha256 },
      now,
    },
  };
}
