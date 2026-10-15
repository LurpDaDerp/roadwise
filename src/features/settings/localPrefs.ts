/**
 * The device-local settings this area writes (plan §10): the units mirror (`units`, for offline
 * display).
 */
import type { SettingsRepo } from '@/data/db/settings';
import { publishUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';

export const UNITS_KEY = 'units';

export type { Units };

export async function readUnits(settings: Pick<SettingsRepo, 'get'>): Promise<Units> {
  return (await settings.get<unknown>(UNITS_KEY)) === 'km' ? 'km' : 'mi';
}

export async function writeUnits(settings: Pick<SettingsRepo, 'set'>, units: Units): Promise<void> {
  await settings.set(UNITS_KEY, units);
  publishUnits(units);
}
