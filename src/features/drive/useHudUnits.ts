import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';

export type HudUnits = Units;

/** The driver's units from the local mirror (shared with every other screen); miles until read. */
export const useHudUnits = (): HudUnits => useUnits();

export const unitLabel = (units: HudUnits): 'mph' | 'km/h' => (units === 'km' ? 'km/h' : 'mph');
