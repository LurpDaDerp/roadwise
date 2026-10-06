import { useEffect, useState } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';

/** The local mirror of `profiles.units` (plan §10; WP9 writes it with `writeUnits`). */
const UNITS_KEY = 'units';
const KMH_PER_MPH = 1.609344;

export type HudUnits = 'mi' | 'km';

/** The driver's units from the local mirror, read once as the screen opens; miles until then. */
export function useHudUnits(): HudUnits {
  const db = useDb();
  const [units, setUnits] = useState<HudUnits>('mi');
  useEffect(() => {
    let live = true;
    createSettingsRepo(db)
      .get<unknown>(UNITS_KEY)
      .then((v) => {
        if (live) setUnits(v === 'km' ? 'km' : 'mi');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [db]);
  return units;
}

/** A whole-mph speed or limit in the driver's units, rounded to a whole number; null stays null. */
export function inUnits(mph: number | null, units: HudUnits): number | null {
  if (mph === null) return null;
  return units === 'km' ? Math.round(mph * KMH_PER_MPH) : mph;
}

export const unitLabel = (units: HudUnits): 'mph' | 'km/h' => (units === 'km' ? 'km/h' : 'mph');
