// The car link over one drive (iPhone, round 14): what the audio route held while it recorded. Pure.
//
// The host feeds it the link as native reports it: the read as the drive opens, every live
// `carLink` event and a fresh read when RoadWise comes to the front or the drive closes, each at the
// host's clock. From that it keeps, per output (by uid), when it was connected; whether a paired
// car, any CarPlay or any Bluetooth or CarPlay output at all was on the route; and when the last
// paired car left it. Three things read it:
// - the drive's car (`tag`): the paired car connected longest, when it was connected for at least
//   half the drive (its start to its end), named as the route last named it;
// - "Are you driving?" (`passengerCheck.ts`): a drive whose route never held a car or any audio;
// - "Where you parked" (`parkedWatch.ts`): when the paired car left the route.
// Which outputs are paired is read from the newest report (a car paired or forgotten mid-drive
// counts as it stands then).
import type { CarLinkState, CarOutput, PairedCar } from '@drive-sense';

import { outputName } from '@/features/carLink/model';

/** The car a drive was in: its uid and the name it had then. */
export interface CarTag {
  uid: string;
  name: string;
}

/** A drive counts as in a car when that car was connected for at least this share of it. */
export const CAR_TAG_SHARE_MIN = 0.5;

interface Span {
  from: number;
  /** null: connected still. */
  to: number | null;
}

export interface CarTally {
  /** A report of the link at host time `at` (a `carLink` event, or a fresh read). */
  observe(state: CarLinkState, at: number): void;
  /** The paired cars as last reported. */
  cars(): readonly PairedCar[];
  /** A paired car is on the route now. */
  pairedNow(): boolean;
  /** CarPlay (paired or not) or a paired car is on the route now: native's `linked`. */
  linkedNow(): boolean;
  /** Any Bluetooth or CarPlay output is on the route now. */
  audioNow(): boolean;
  /** Since the drive opened, the route held a paired car. */
  pairedEver(): boolean;
  /** Since the drive opened, the route held CarPlay (paired or not). */
  carPlayEver(): boolean;
  /** Since the drive opened, the route held any Bluetooth or CarPlay output (headphones, a car, anything). */
  audioEver(): boolean;
  /** Native said, as the tally began, that a paired car or CarPlay was on the route earlier in this drive and has gone. */
  linkedBefore(): boolean;
  /** When the last paired car left the route (one was on it before, none since); null while one is on it, or none ever was. */
  pairedLeftAt(): number | null;
  /** How long `uid` was connected between `from` and `to` (ms). */
  connectedMs(uid: string, from: number, to: number): number;
  /** The drive's car: the paired car connected longest between `from` and `to`, when for at least half of it; null otherwise. */
  tag(from: number, to: number): CarTag | null;
}

const isPaired = (cars: readonly PairedCar[], uid: string): boolean => cars.some((c) => c.uid === uid);

/**
 * A tally from the link as the drive opens (`state`, read at `at`). `creditFrom`: the outputs on the
 * route then count as connected since this time (the drive's start, for a drive that just began;
 * the open itself for one taken up again after a relaunch, whose earlier minutes nobody saw).
 * `linkedBefore`: native's `goneSince` then fell in this drive (the link was up before the tally began).
 */
export function createCarTally(state: CarLinkState, at: number, creditFrom: number = at, linkedBefore = false): CarTally {
  const spans = new Map<string, Span[]>();
  /** The newest name the route gave each output (a renamed car shows its new name). */
  const names = new Map<string, string>();
  let cars: readonly PairedCar[] = state.cars;
  let current: readonly CarOutput[] = [];
  let linked = false;
  let pairedEver = false;
  let carPlayEver = false;
  let audioEver = false;
  let pairedOn = false;
  let leftAt: number | null = null;

  function take(s: CarLinkState, t: number, since: number): void {
    cars = s.cars;
    const now = new Set(s.current.map((o) => o.uid));
    for (const [uid, list] of spans) {
      const last = list[list.length - 1];
      if (last !== undefined && last.to === null && !now.has(uid)) last.to = Math.max(last.from, t);
    }
    for (const o of s.current) {
      if (o.name.trim() !== '') names.set(o.uid, o.name);
      const list = spans.get(o.uid) ?? [];
      const last = list[list.length - 1];
      if (last === undefined || last.to !== null) list.push({ from: since, to: null });
      spans.set(o.uid, list);
    }
    current = s.current;
    linked = s.linked;
    if (s.current.length > 0) audioEver = true;
    if (s.current.some((o) => o.type === 'carAudio')) carPlayEver = true;
    const on = s.current.some((o) => isPaired(s.cars, o.uid));
    if (on) pairedEver = true;
    if (pairedOn && !on) leftAt = t;
    if (on) leftAt = null;
    pairedOn = on;
  }

  take(state, at, Math.min(creditFrom, at));

  function connectedMs(uid: string, from: number, to: number): number {
    if (!(to > from)) return 0;
    let ms = 0;
    for (const s of spans.get(uid) ?? []) {
      const a = Math.max(s.from, from);
      const b = Math.min(s.to ?? to, to);
      if (b > a) ms += b - a;
    }
    return ms;
  }

  return {
    observe: (s, t) => take(s, t, t),
    cars: () => cars,
    pairedNow: () => pairedOn,
    linkedNow: () => linked,
    audioNow: () => current.length > 0,
    pairedEver: () => pairedEver,
    carPlayEver: () => carPlayEver,
    audioEver: () => audioEver,
    linkedBefore: () => linkedBefore,
    pairedLeftAt: () => leftAt,
    connectedMs,
    tag(from, to) {
      if (!(to > from)) return null;
      let best: { car: PairedCar; ms: number } | null = null;
      for (const car of cars) {
        const ms = connectedMs(car.uid, from, to);
        if (ms > 0 && (best === null || ms > best.ms)) best = { car, ms };
      }
      if (best === null || best.ms < CAR_TAG_SHARE_MIN * (to - from)) return null;
      return { uid: best.car.uid, name: outputName({ name: names.get(best.car.uid) ?? best.car.name, type: best.car.type }) };
    },
  };
}

/**
 * A drive no tally saw (native ended it while RoadWise was away, and it was taken in at a launch):
 * the car native itself kept for that drive (the outputs current for most of its rows), when one of
 * them is paired now. Null otherwise.
 */
export function nativeCarTag(state: CarLinkState, driveIds: readonly string[]): CarTag | null {
  const seen = state.drives.find((d) => driveIds.includes(d.driveId));
  if (seen === undefined) return null;
  for (const o of seen.outputs) {
    const car = state.cars.find((c) => c.uid === o.uid);
    if (car !== undefined) return { uid: car.uid, name: outputName(car) };
  }
  return null;
}
