// The DMS settings (plan §10): `dms.enabled` (boolean, off by default) and `dms.calibratedAt` (epoch ms, null
// until the setup has run once). WP8 owns their meaning; Home's chip (src/features/home/useDmsSetting.ts) reads
// and writes `dms.enabled` under the same keys and the same react-query key, so a change here shows there.
//
// Turning DMS on (the settings switch or Home's chip): the camera permission is asked only then, with a one-line
// reason; then the setup if never calibrated; then on. `enableStep` is that decision, pure.
import type { SettingsRepo } from '@/data/db/settings';

import type { CameraPermission } from './bridge';

export const DMS_ENABLED_KEY = 'dms.enabled';
export const DMS_CALIBRATED_KEY = 'dms.calibratedAt';
/** The query Home's chip and the settings screen share (useDmsSetting's). */
export const DMS_SETTING_QUERY_KEY = ['settings', 'dms-chip'] as const;

export type EnableStep = 'permission_denied' | 'setup' | 'enabled' | 'unavailable';

/** What turning DMS on leads to, given the camera permission answer and whether the setup has ever run. */
export function enableStep(permission: CameraPermission, calibrated: boolean): EnableStep {
  if (permission === 'unavailable') return 'unavailable';
  if (permission !== 'granted') return 'permission_denied';
  return calibrated ? 'enabled' : 'setup';
}

export interface DmsPrefs {
  enabled: boolean;
  /** epoch ms of the last successful setup, or null */
  calibratedAt: number | null;
}

export async function readDmsPrefs(settings: Pick<SettingsRepo, 'getMany'>): Promise<DmsPrefs> {
  const v = await settings.getMany([DMS_ENABLED_KEY, DMS_CALIBRATED_KEY]);
  const at = v[DMS_CALIBRATED_KEY];
  return { enabled: v[DMS_ENABLED_KEY] === true, calibratedAt: typeof at === 'number' && Number.isFinite(at) ? at : null };
}

export async function writeDmsEnabled(settings: Pick<SettingsRepo, 'set'>, on: boolean): Promise<void> {
  await settings.set(DMS_ENABLED_KEY, on);
}

/** A successful setup: calibrated now, and on. */
export async function writeDmsCalibrated(settings: Pick<SettingsRepo, 'set'>, atMs: number): Promise<void> {
  await settings.set(DMS_CALIBRATED_KEY, atMs);
  await settings.set(DMS_ENABLED_KEY, true);
}
