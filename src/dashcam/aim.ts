// The aiming screen's meaning of DashPal's AIM frames (docs/BLE_PROTOCOL.md §3.1, §3.5): the border
// colour from the score, the good latch, the hint line under the mirrored picture and when a screen
// reader hears it. DashPal scores the aim itself; the phone only shows it. Pure: no storage, no
// logging, no reports.
import { dashpalCopy } from './copy';
import type { AimFrame } from './protocol';

/**
 * The border's three colours per scheme (bad, the neutral middle, good: an orange-red to a
 * teal-blue, told apart with colour blindness, with the ends' OKLab midpoint between them), at the
 * smoothed scores of `AIM_INPUT`. Local constants, not theme tokens: they carry a meaning.
 */
export const AIM_STOPS = {
  light: ['#B93C00', '#7F6356', '#007585'],
  dark: ['#FF9152', '#BBB6A0', '#3CCFE0'],
} as const;
/** Fully bad at 0.20 or less, the middle at 0.55, fully good at 0.90 or more (score / 100). */
export const AIM_INPUT = [0.2, 0.55, 0.9] as const;

/** The border follows the received score over this long (`withTiming`; at once under Reduce Motion). */
export const AIM_SMOOTH_MS = 300;
/** No AIM this long: a neutral border, "Waiting for the picture…", no verdict. */
export const AIM_STALE_MS = 1000;
/** The good latch: on once every score for 1 s is 90 or more, off once every score for 0.5 s is under 80. */
export const AIM_GOOD = 90;
export const AIM_GOOD_ON_MS = 1000;
export const AIM_GOOD_OFF = 80;
export const AIM_GOOD_OFF_MS = 500;
/** A changed hint is said after it has held this long, at most this often (entering good: at once). */
export const AIM_SAY_HELD_MS = 1000;
export const AIM_SAY_EVERY_MS = 2000;
/** The border's width, and while the good latch is on. */
export const AIM_BORDER = 6;
export const AIM_BORDER_GOOD = 8;

export type AimScheme = keyof typeof AIM_STOPS;

/** The score byte as 0..1 (a byte above 100 counts as 100). */
export const aimLevel = (score: number): number => Math.min(100, Math.max(0, score)) / 100;

const GAMMA = 2.2;

function channels(hex: string): [number, number, number] {
  'worklet';
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

const hex2 = (v: number): string => {
  'worklet';
  return v.toString(16).padStart(2, '0');
};

/**
 * The border colour at the smoothed level `s` (0..1): the stops mixed in linear light (gamma 2.2),
 * clamped at the ends. The same colour Reanimated's `interpolateColor(s, AIM_INPUT, AIM_STOPS[scheme])`
 * draws (the test holds them equal), as `#rrggbb`.
 */
export function aimColor(s: number, scheme: AimScheme): string {
  'worklet';
  const stops = AIM_STOPS[scheme];
  const x = Number.isFinite(s) ? s : 0;
  let i = 0;
  if (x >= AIM_INPUT[1]) i = 1;
  const lo = AIM_INPUT[i]!;
  const hi = AIM_INPUT[i + 1]!;
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  const a = channels(stops[i]!);
  const b = channels(stops[i + 1]!);
  let out = '#';
  for (let k = 0; k < 3; k++) {
    const la = Math.pow(a[k]! / 255, GAMMA);
    const lb = Math.pow(b[k]! / 255, GAMMA);
    out += hex2(Math.round(Math.pow(la + (lb - la) * t, 1 / GAMMA) * 255));
  }
  return out;
}

/**
 * The good latch (the check, "Good position" and the haptic; never the colour): on once every score
 * for `AIM_GOOD_ON_MS` is at least 90, off once every score for `AIM_GOOD_OFF_MS` is under 80. A
 * missing reading (stale, a stopped picture) clears it.
 */
export interface GoodLatch {
  /** One AIM score (0-100) at `at`, or null (no reading): whether the latch is on after it. */
  push(score: number | null, at: number): boolean;
  good(): boolean;
}

export function createGoodLatch(): GoodLatch {
  let on = false;
  /** the first score of the current run at 90 or more, and of the current run under 80 */
  let highFrom: number | null = null;
  let lowFrom: number | null = null;
  return {
    push(score, at) {
      if (score === null) {
        on = false;
        highFrom = null;
        lowFrom = null;
        return on;
      }
      const v = Math.min(100, Math.max(0, score));
      highFrom = v >= AIM_GOOD ? (highFrom ?? at) : null;
      lowFrom = v < AIM_GOOD_OFF ? (lowFrom ?? at) : null;
      if (!on && highFrom !== null && at - highFrom >= AIM_GOOD_ON_MS) on = true;
      else if (on && lowFrom !== null && at - lowFrom >= AIM_GOOD_OFF_MS) on = false;
      return on;
    },
    good: () => on,
  };
}

/**
 * The hint line for DashPal's hint code. DashPal names the picture's sides as it sends it; the
 * phone shows the picture as a mirror, so EDGE_LEFT (2) and EDGE_RIGHT (3) swap. The camera's sides
 * (8, 9) are the driver's and never swap. An unknown code reads as the generic line.
 */
export function hintText(hint: number): string {
  const shown = hint === 2 ? 3 : hint === 3 ? 2 : hint;
  return dashpalCopy.wizard.aim.hint[shown] ?? dashpalCopy.wizard.aim.hintUnknown;
}

/** The hint the screen shows for an AIM frame, or "Waiting for the picture…" with no fresh one. */
export const aimLine = (aim: AimFrame | null): string => (aim ? hintText(aim.hint) : dashpalCopy.wizard.aim.waiting);

/**
 * When a screen reader hears the hint line: a line that changed is said once it has held
 * `AIM_SAY_HELD_MS`, at most every `AIM_SAY_EVERY_MS`; entering the good latch is said at once
 * ("Good position").
 */
export interface AimAnnouncer {
  /** The line shown at `at` and whether the good latch just came on: the words to say now, or null. */
  next(line: string, enteredGood: boolean, at: number): string | null;
}

export function createAimAnnouncer(): AimAnnouncer {
  let line: string | null = null;
  let since = 0;
  let said: string | null = null;
  let saidAt = -Infinity;
  return {
    next(text, enteredGood, at) {
      if (text !== line) {
        line = text;
        since = at;
      }
      if (enteredGood) {
        said = dashpalCopy.wizard.aim.good;
        saidAt = at;
        return said;
      }
      if (text === said || at - since < AIM_SAY_HELD_MS || at - saidAt < AIM_SAY_EVERY_MS) return null;
      said = text;
      saidAt = at;
      return text;
    },
  };
}
