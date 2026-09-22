// Battery at the start and end of the last drive (U5, `diag.battery`), for the device pass's
// battery budget (design §3.5: pocket ≤ 6–8 %/h, mounted ≤ 12–15 %/h).
//
// §3.5 forbids any timer, query or sensor while armed and idle, so nothing here polls:
// - `createDriveBatteryRecorder` takes exactly two one-shot readings per drive, on the host's own
//   transitions — when a trip starts recording and when it returns to idle — and does nothing on
//   the 1 Hz rows between (one boolean compare). H2 mounts it, and only in a diagnostics build
//   (`diagnosticsEnabled()`); a dry run (the parked simulation) is never recorded.
// - The live level on the diagnostics screen comes from expo-battery's listener hooks, which exist
//   only while the screen is mounted.
import * as Battery from 'expo-battery';

import type { SettingsRepo } from '@/data/db';
import type { DriveHost } from '@/drive/host';
import { isBusyStatus } from '@/drive/policy';

export const DIAG_BATTERY_KEY = 'diag.battery';

export interface BatteryReading {
  /** 0..1, or null where the platform does not report it (a simulator) */
  level: number | null;
  lowPower: boolean | null;
  /** epoch ms */
  at: number;
}

export interface DriveBatteryRecord {
  clientTripId: string | null;
  start: BatteryReading | null;
  /** null while the drive is still open, or if the app never saw it close */
  end: BatteryReading | null;
}

/** One reading, now. */
export async function readBattery(now: () => number = Date.now): Promise<BatteryReading> {
  const at = now();
  const [level, lowPower] = await Promise.all([
    Battery.getBatteryLevelAsync().catch(() => -1),
    Battery.isLowPowerModeEnabledAsync().catch(() => null),
  ]);
  return { level: level >= 0 ? level : null, lowPower, at };
}

export async function readDriveBattery(settings: Pick<SettingsRepo, 'get'>): Promise<DriveBatteryRecord | null> {
  return settings.get<DriveBatteryRecord>(DIAG_BATTERY_KEY);
}

export interface DriveBatteryRecorderDeps {
  host: Pick<DriveHost, 'snapshot' | 'subscribe'>;
  settings: Pick<SettingsRepo, 'get' | 'set'>;
  read?: () => Promise<BatteryReading>;
  onError?: (e: unknown) => void;
}

/**
 * Records `diag.battery` for each real drive: a reading when it starts recording (a candidate
 * that is discarded is not a drive) and one when it closes. Returns the unsubscribe.
 */
export function createDriveBatteryRecorder(deps: DriveBatteryRecorderDeps): () => void {
  const read = deps.read ?? (() => readBattery());
  let open = deps.host.snapshot().status === 'recording';
  let tripId: string | null = open ? deps.host.snapshot().clientTripId : null;
  // The two writes of one drive land in order, whatever the storage latency.
  let chain: Promise<void> = Promise.resolve();
  const queue = (task: () => Promise<void>) => {
    chain = chain.then(task).catch((e: unknown) => deps.onError?.(e));
  };

  return deps.host.subscribe((s) => {
    if (s.dryRun) return;
    if (!open) {
      if (s.status !== 'recording') return;
      open = true;
      tripId = s.clientTripId;
      const reading = read();
      const id = tripId;
      queue(async () => {
        const start = await reading;
        await deps.settings.set(DIAG_BATTERY_KEY, { clientTripId: id, start, end: null } satisfies DriveBatteryRecord);
      });
      return;
    }
    if (isBusyStatus(s.status)) return;
    open = false;
    const reading = read();
    const id = tripId;
    queue(async () => {
      const end = await reading;
      const prior = await deps.settings.get<DriveBatteryRecord>(DIAG_BATTERY_KEY);
      const start = prior && prior.clientTripId === id ? prior.start : null;
      await deps.settings.set(DIAG_BATTERY_KEY, { clientTripId: id, start, end } satisfies DriveBatteryRecord);
    });
  });
}

/** "82 %", or "Not reported" where the platform gives no level. */
export function formatLevel(level: number | null): string {
  return level === null ? 'Not reported' : `${Math.round(level * 100)} %`;
}
