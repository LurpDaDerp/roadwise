// The car link's screen rules (both phones): which output the pairing screen offers first, the
// headphones warning, the Settings row's line and Home's "Is <name> your car?". Pure. `carAudio` is
// CarPlay on iPhone and Android Auto on Android; the headphones and hearing-aid names are one list
// for both.
import type { CarLinkState, CarOutput } from '@drive-sense';

import { carCopy } from './copy';

/** Home's "Is <name> your car?" card was closed, for good (cleared at sign-out with the other device settings). */
export const CAR_CARD_DISMISSED_KEY = 'home.carCardDismissed';
/** At most this many paired cars (native's CARS_MAX). */
export const CARS_MAX = 3;
/** An output current for most of this many of the last 3 drives is suggested (CarPlay after one). */
export const SUGGEST_DRIVES = 2;

/**
 * Android only: Android Auto listed alone, as native lists it when the car it shows on could not be
 * told by the car's Bluetooth (CarLinkRecord.kt's `CarOutputs.listed`); otherwise Android Auto is
 * the car's own Bluetooth output, under its name, as CarPlay is on iPhone. iPhone never has this uid.
 */
export const ANDROID_AUTO_UID = 'android-auto';

/** The name the screens show: the phone's own name for it, or its kind. */
export const outputName = (o: Pick<CarOutput, 'name' | 'type'>): string => (o.name.trim() !== '' ? o.name.trim() : carCopy.unnamed(o.type));

/** The kind line under a name: Bluetooth, CarPlay or Android Auto; "Any car with Android Auto" for Android Auto listed alone (its name already says Android Auto). */
export const outputKind = (o: Pick<CarOutput, 'uid' | 'type'>): string => (o.uid === ANDROID_AUTO_UID ? carCopy.anyCar : carCopy.kind(o.type));

/** Home's card title: "Is <name> your car?", or "Do you drive with Android Auto?" for Android Auto listed alone. */
export const suggestionTitle = (o: Pick<CarOutput, 'uid' | 'name' | 'type'>): string =>
  o.uid === ANDROID_AUTO_UID ? carCopy.card.askAnyCar : carCopy.card.askTitle(outputName(o));

const HEADPHONES =
  /\b(air ?pods|pods|beats|powerbeats|(ear)?buds|galaxy buds|pixel buds|ear ?phones|head ?phones|headset|wh-?1000|wf-?1000|sony wh|sony wf|quietcomfort|bose|jabra|jbl|sennheiser|nothing ear|soundcore|shokz|hearing|phonak|oticon|resound|signia|starkey|watch)/i;

/**
 * A name that reads like headphones, earbuds, a hearing aid or a watch, not a car. A watch is for
 * Android, where one can hold the phone's hands-free link (native leaves it out by its Bluetooth
 * class when Nearby devices allows reading it); iPhone never lists a watch as audio.
 */
export const looksLikeHeadphones = (name: string): boolean => HEADPHONES.test(name);

/** Whether an output can be paired: CarPlay always, a Bluetooth output only when its name doesn't read like headphones or a hearing aid. */
export const canPair = (o: Pick<CarOutput, 'name' | 'type'>): boolean => o.type === 'carAudio' || !looksLikeHeadphones(o.name);

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
      canPair(x.output) &&
      (x.drives >= SUGGEST_DRIVES || (x.output.type === 'carAudio' && x.drives >= 1))
  );
  picks.sort((a, b) => b.drives - a.drives || b.newest - a.newest);
  return picks[0]?.output ?? null;
}
