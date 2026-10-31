// The car link's screen rules (iPhone): which output the pairing screen offers first, the headphones
// warning, the Settings row's line and Home's "Is <name> your car?". Pure.
import type { CarLinkState, CarOutput } from '@drive-sense';

import { carCopy } from './copy';

/** Home's dismissal of its car card, for good (cleared at sign-out with the other device settings). */
export const CAR_CARD_DISMISSED_KEY = 'home.carCardDismissed';
/** At most this many paired cars (native's CARS_MAX). */
export const CARS_MAX = 3;
/** An output current for most of this many of the last 3 drives is suggested (CarPlay after one). */
export const SUGGEST_DRIVES = 2;

/** The name the screens show: the phone's own name for it, or its kind. */
export const outputName = (o: Pick<CarOutput, 'name' | 'type'>): string => (o.name.trim() !== '' ? o.name.trim() : carCopy.unnamed(o.type));

const HEADPHONES = /\b(air ?pods|beats|powerbeats|(ear)?buds|galaxy buds|pixel buds|ear ?phones|head ?phones|headset|wh-?1000|wf-?1000|quietcomfort|soundcore|shokz)/i;

/** A name that reads like headphones or earbuds, not a car. */
export const looksLikeHeadphones = (name: string): boolean => HEADPHONES.test(name);

export const isPaired = (s: CarLinkState, uid: string): boolean => s.cars.some((c) => c.uid === uid);

/**
 * The output the pairing screen offers first: the one chosen, while it is still connected; else
 * CarPlay not yet paired, else any output not yet paired, else the first. Null with nothing connected.
 */
export function preselect(s: CarLinkState, chosen: string | null): CarOutput | null {
  if (chosen !== null) {
    const still = s.current.find((o) => o.uid === chosen);
    if (still) return still;
  }
  const fresh = s.current.filter((o) => !isPaired(s, o.uid));
  return fresh.find((o) => o.type === 'carAudio') ?? fresh[0] ?? s.current[0] ?? null;
}

/** Settings › Your car's line: the paired cars' names, or "Not paired". */
export const carRowLine = (s: CarLinkState | null): string => (s === null || s.cars.length === 0 ? carCopy.row.none : s.cars.map(outputName).join(', '));

/**
 * Home's "Is <name> your car?": an output current for most of 2 of the last 3 drives (CarPlay after
 * one), not paired, not marked "Not my car" and not named like headphones; the one on the most
 * drives, the newest first on a tie, with the name its newest drive saw. Null when there is none or
 * 3 cars are paired. Never pairs: the driver's tap does.
 */
export function carSuggestion(s: CarLinkState): CarOutput | null {
  if (s.cars.length >= CARS_MAX) return null;
  const seen = new Map<string, { output: CarOutput; drives: number; newest: number }>();
  s.drives.slice(-3).forEach((d, i) => {
    for (const o of d.outputs) {
      const was = seen.get(o.uid);
      seen.set(o.uid, { output: o, drives: (was?.drives ?? 0) + 1, newest: i });
    }
  });
  const picks = [...seen.values()].filter(
    (x) =>
      !isPaired(s, x.output.uid) &&
      !s.notMine.includes(x.output.uid) &&
      !looksLikeHeadphones(x.output.name) &&
      (x.drives >= SUGGEST_DRIVES || (x.output.type === 'carAudio' && x.drives >= 1))
  );
  picks.sort((a, b) => b.drives - a.drives || b.newest - a.newest);
  return picks[0]?.output ?? null;
}
