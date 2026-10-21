/** The words a spot's row and sheet put together from its numbers. Pure. */
import type { ProblemSpot } from '@/data/queries/spots';
import { KMH_PER_MPH, type Units } from '@/lib/units';

import { DIRECTIONS, spotsCopy, type Direction } from './copy';

/** The 45° sector a heading falls in: north is 337.5° to 22.5°. */
export function dirWord(headingDeg: number): Direction {
  const h = Number.isFinite(headingDeg) ? ((headingDeg % 360) + 360) % 360 : 0;
  return DIRECTIONS[Math.round(h / 45) % 8]!;
}

/** A spot's title: its street, else "Spot heading north". */
export const spotTitle = (s: Pick<ProblemSpot, 'label' | 'headingDeg'>): string => s.label ?? spotsCopy.fallbackTitle(dirWord(s.headingDeg));

/** "4 of your last 6 drives here". */
export const howOften = (s: Pick<ProblemSpot, 'recentHits' | 'recentPasses'>): string => spotsCopy.howOften(s.recentHits, s.recentPasses);

/** A posted limit in the driver's units: "35 mph", "56 km/h". */
export const limitText = (mph: number, units: Units): string => (units === 'km' ? `${Math.round(mph * KMH_PER_MPH)} km/h` : `${Math.round(mph)} mph`);

/** What happens at a spot: "Over the 35 mph limit", "Braking hard". */
export function whatHappens(s: Pick<ProblemSpot, 'kind' | 'limitMph'>, units: Units): string {
  if (s.kind !== 'speeding') return spotsCopy.sheet.what[s.kind];
  return s.limitMph !== null && s.limitMph > 0 ? spotsCopy.sheet.overLimit(limitText(s.limitMph, units)) : spotsCopy.sheet.overUnknownLimit;
}

/** Clean drives in a row get a "Getting better" pill from this many on. */
export const GETTING_BETTER_FROM = 2;
export const gettingBetter = (s: Pick<ProblemSpot, 'cleanStreak'>): boolean => s.cleanStreak >= GETTING_BETTER_FROM;

/** The sheet's progress block: a title and, once a clean run has started, how many more clear it. */
export function progress(s: Pick<ProblemSpot, 'cleanStreak' | 'cleanNeeded'>): { title: string; line: string | null } {
  if (s.cleanStreak <= 0) return { title: spotsCopy.sheet.clearsAfter(s.cleanNeeded), line: null };
  return { title: spotsCopy.sheet.cleanRun(s.cleanStreak), line: spotsCopy.sheet.moreToClear(Math.max(1, s.cleanNeeded - s.cleanStreak)) };
}

/** The map chip's text: the street clipped to 16 characters, else the kind's short word. */
export const CHIP_MAX_CHARS = 16;
export function chipText(s: Pick<ProblemSpot, 'label' | 'kind'>): string {
  if (s.label === null || s.label === '') return spotsCopy.mapChip[s.kind];
  return s.label.length > CHIP_MAX_CHARS ? `${s.label.slice(0, CHIP_MAX_CHARS - 1)}…` : s.label;
}
