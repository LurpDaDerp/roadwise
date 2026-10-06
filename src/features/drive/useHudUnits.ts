import { useUnits } from '@/data/queries/units';
import { KMH_PER_MPH, type Units } from '@/lib/units';

export type HudUnits = Units;

/** The driver's units from the local mirror (shared with every other screen); miles until read. */
export const useHudUnits = (): HudUnits => useUnits();

/** A speed or limit in the driver's units, rounded once to a whole number; null stays null. */
export function inUnits(mph: number | null, units: HudUnits): number | null {
  if (mph === null) return null;
  return Math.round(units === 'km' ? mph * KMH_PER_MPH : mph);
}

export const unitLabel = (units: HudUnits): 'mph' | 'km/h' => (units === 'km' ? 'km/h' : 'mph');
