// The driving screen's compass (round 8 plan, decision 7): the card turns to where the car is going,
// worked out by the engine from where it went (`useBearing`: the track bearing, held while stopped).
// Before the drive's first track bearing it follows the phone's own compass (expo-location's heading:
// true north when iOS knows it, else magnetic), smoothed so it doesn't jitter. Once a track bearing
// has shown it stays for the rest of the drive: never back to the phone's heading. The phone's
// heading is read only on iOS, in portrait (iOS measures it from the top of the phone held upright,
// so it is a quarter turn off in landscape), while the driving screen is focused with RoadWise in
// front (Control Center, a call banner or Siri over it included: only the background stops it) and
// the compass is drawn; with no heading to show the card sits north-up, its letters dimmed.
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

/** How often the smoothed heading steps toward the newest reading, ms. */
export const DEVICE_HEADING_TICK_MS = 250;
/** Each step moves this share of the way to the newest reading (about 0.5 s to settle most of the way). */
export const DEVICE_HEADING_ALPHA = 0.4;
/** The shown heading changes once the smoothed one is this far from it, degrees… */
export const DEVICE_HEADING_STEP_DEG = 3;
/** …or once the smoothed heading has settled on the newest reading (come this close: it then takes it exactly). */
export const DEVICE_HEADING_SETTLE_DEG = 0.5;

const norm = (d: number): number => {
  const r = ((d % 360) + 360) % 360;
  return r === 360 ? 0 : r;
};

/** The signed turn from `from` to `to` the short way, degrees in (-180, 180]. */
export function headingDelta(from: number, to: number): number {
  const d = norm(to - from);
  return d > 180 ? d - 360 : d;
}

/** The fields of expo-location's `LocationHeadingObject` read here. */
export interface HeadingReading {
  trueHeading?: unknown;
  magHeading?: unknown;
  accuracy?: unknown;
}

const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * A reading's heading, degrees clockwise from north in [0, 360): true north when it is known (≥ 0),
 * else magnetic; null when the reading is unusable (iOS's accuracy 0: uncalibrated or more than 50°
 * out, or no heading at all).
 */
export function headingOf(h: HeadingReading | null | undefined): number | null {
  if (h === null || h === undefined) return null;
  if (!(typeof h.accuracy === 'number' && h.accuracy >= 1)) return null;
  if (valid(h.trueHeading)) return norm(h.trueHeading);
  if (valid(h.magHeading)) return norm(h.magHeading);
  return null;
}

/** The smoothing's state: the newest reading, the smoothed heading and the one shown (null: none yet). */
export interface HeadingFilter {
  raw: number | null;
  smoothed: number | null;
  shown: number | null;
}

export const NO_HEADING: HeadingFilter = Object.freeze({ raw: null, smoothed: null, shown: null });

/** A new reading: the first one shows at once; later ones wait for the next tick. Pure. */
export function readHeading(f: HeadingFilter, deg: number): HeadingFilter {
  if (f.smoothed === null || f.shown === null) return { raw: deg, smoothed: deg, shown: deg };
  return { ...f, raw: deg };
}

/**
 * One tick: the smoothed heading moves `DEVICE_HEADING_ALPHA` of the short way toward the newest
 * reading, and takes it exactly once within `DEVICE_HEADING_SETTLE_DEG` of it. The shown heading
 * follows the smoothed one once it is `DEVICE_HEADING_STEP_DEG` away, or once the smoothed one has
 * settled (so a turn ends exactly where the phone points, and noise under the step never turns the
 * card until the phone holds still). Returns `f` itself when nothing changed. Pure.
 */
export function tickHeading(f: HeadingFilter): HeadingFilter {
  if (f.raw === null || f.smoothed === null || f.shown === null) return f;
  const moved = norm(f.smoothed + DEVICE_HEADING_ALPHA * headingDelta(f.smoothed, f.raw));
  const settled = Math.abs(headingDelta(moved, f.raw)) < DEVICE_HEADING_SETTLE_DEG;
  const smoothed = settled ? f.raw : moved;
  const shown = settled || Math.abs(headingDelta(f.shown, smoothed)) >= DEVICE_HEADING_STEP_DEG ? smoothed : f.shown;
  if (smoothed === f.smoothed && shown === f.shown) return f;
  return { raw: f.raw, smoothed, shown };
}

/**
 * The phone's heading while `enabled` (degrees clockwise from north, smoothed), else null. It
 * subscribes to expo-location's heading only while enabled and removes the subscription as soon as
 * it is not (and on unmount). A refused permission, a phone with no compass or a failed stream
 * leaves it null, silently.
 */
export function useDeviceHeading(enabled: boolean): number | null {
  const [heading, setHeading] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // The stream failed: nothing more is shown until the next subscription.
    let failed = false;
    let sub: { remove(): void } | null = null;
    let f: HeadingFilter = NO_HEADING;
    const show = (next: HeadingFilter) => {
      const before = f.shown;
      f = next;
      if (live && next.shown !== before) setHeading(next.shown);
    };
    const timer = setInterval(() => show(tickHeading(f)), DEVICE_HEADING_TICK_MS);
    const stop = () => {
      clearInterval(timer);
      if (sub !== null) {
        const s = sub;
        sub = null;
        try {
          s.remove();
        } catch {
          // Already gone.
        }
      }
    };
    const onReading = (h: HeadingReading) => {
      if (!live || failed) return;
      const deg = headingOf(h);
      if (deg !== null) show(readHeading(f, deg));
    };
    const onError = () => {
      // The stream ended (no compass, interference): nothing to show until the next subscription.
      if (!live || failed) return;
      failed = true;
      stop();
      f = NO_HEADING;
      setHeading(null);
    };
    Promise.resolve()
      .then(() => Location.watchHeadingAsync(onReading, onError))
      .then(
        (s) => {
          if (live && !failed) sub = s;
          else s.remove();
        },
        () => {
          // No permission or no heading: the compass waits for the drive's own bearing.
          if (live) onError();
        }
      )
      .catch(() => {});
    return () => {
      live = false;
      stop();
      setHeading(null);
    };
  }, [enabled]);
  return enabled ? heading : null;
}

/** The last track bearing the screen showed, and the drive it belongs to. */
export interface HeldTrack {
  tripId: string | null;
  deg: number;
}

/**
 * The held track bearing after this render: the drive's newest track bearing when there is one; a
 * different drive starts afresh; otherwise the last one stays (a drive never goes back to the
 * phone's heading). Returns `held` itself when nothing changed. Pure.
 */
export function nextHeldTrack(held: HeldTrack | null, track: number | null, tripId: string | null): HeldTrack | null {
  if (track !== null && Number.isFinite(track)) {
    return held !== null && held.tripId === tripId && held.deg === track ? held : { tripId, deg: track };
  }
  // A drive's end clears its id; a new drive (another id) never inherits the last one's bearing.
  if (held !== null && tripId !== null && held.tripId !== tripId) return null;
  return held;
}

/** The compass's heading: the drive's track bearing (held), else the phone's, else none (north-up, letters dimmed). */
export function compassHeadingOf(track: HeldTrack | null, device: number | null): number | null {
  if (track !== null) return track.deg;
  return device;
}

/**
 * Whether the phone's heading is read now (iOS, portrait, the compass drawn, the screen focused with
 * RoadWise in front, a drive recording, no track bearing yet). `active`: RoadWise is not in the
 * background (an overlay such as Control Center over the screen still counts as in front).
 */
export function deviceHeadingWanted(o: {
  ios: boolean;
  focused: boolean;
  active: boolean;
  recording: boolean;
  ring: boolean;
  portrait: boolean;
  hasTrack: boolean;
}): boolean {
  return o.ios && o.focused && o.active && o.recording && o.ring && o.portrait && !o.hasTrack;
}
