/**
 * Day and night minutes of a practice drive, under a state's night rule. Pure.
 *
 * The drive's wall time (start to end) is stepped a minute at a time, the last partial minute
 * included. Each step is judged at its middle, at a point between where the drive started and
 * where it ended (straight-line interpolation; a practice log needs the clock, not the road), with
 * that day's sunrise and sunset there (`sunTimes`, the 90.833° zenith of the almanacs). A drive
 * that crosses midnight is judged step by step like any other. Under the midnight sun no minute is
 * night, and in the polar night every minute is.
 *
 * A drive archived after 183 days has lost its position, but its night minutes under each rule were
 * kept just before (`keepArchivedNight`, passed in as `kept`): the night is that, the rest of its
 * wall time day. A drive with no position and nothing kept (restored from the server without a
 * route, or archived before Permit mode was first turned on) falls back to its own night share: its
 * duration times its night miles (sunset to sunrise, whatever the rule) over its miles, the rest by
 * day.
 */
import type { LocalDrive } from '@/data/queries/rows';
import { decodeRoute } from '@/features/drives/route';
import type { LatLng } from '@/lib/geo';
import { sunTimes } from '@/ui/sky/solar';

import type { NightByRule } from './notes';
import { NIGHT_RULES, type NightRule } from './states';

const MIN_MS = 60_000;

/** How far night starts after sunset (and ends before sunrise) under each rule, in ms. */
const OFFSET_MS: Record<NightRule, number> = {
  sunset: 0,
  dark30: 30 * MIN_MS,
  md30: -30 * MIN_MS,
};

/** Whether `ms` is night at the point under `rule`. */
export function isNightAt(ms: number, lat: number, lng: number, rule: NightRule): boolean {
  const sun = sunTimes(new Date(ms), lat, lng);
  if (sun.polar === 'day') return false;
  if (sun.polar === 'night') return true;
  if (sun.sunrise === null || sun.sunset === null) return false;
  const off = OFFSET_MS[rule];
  return ms >= sun.sunset.getTime() + off || ms < sun.sunrise.getTime() - off;
}

export interface PracticeMinutes {
  dayMin: number;
  nightMin: number;
}

/** What `practiceMinutes` reads of a drive. */
export type PracticeDriveFacts = Pick<LocalDrive, 'startedAt' | 'endedAt' | 'durationS' | 'miles' | 'nightMiles' | 'polyline' | 'start' | 'end'>;

const finitePoint = (p: LatLng | undefined | null): LatLng | null =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : null;

/** Where the drive started and ended: its stored ends, else its route's first and last points. */
export function driveEnds(d: Pick<LocalDrive, 'polyline' | 'start' | 'end'>): { from: LatLng; to: LatLng } | null {
  let from = finitePoint(d.start);
  let to = finitePoint(d.end);
  if (from === null || to === null) {
    const runs = decodeRoute(d.polyline);
    const first = runs[0]?.[0];
    const lastRun = runs[runs.length - 1];
    const last = lastRun?.[lastRun.length - 1];
    from = from ?? finitePoint(first);
    to = to ?? finitePoint(last);
  }
  if (from === null && to === null) return null;
  return { from: from ?? (to as LatLng), to: to ?? (from as LatLng) };
}

/** The drive's minutes by day and by night under `rule` (see the module note). */
export function practiceMinutes(d: PracticeDriveFacts, rule: NightRule, kept?: NightByRule | null): PracticeMinutes {
  const start = d.startedAt;
  const end = d.endedAt ?? start + Math.max(0, d.durationS) * 1000;
  const ends = driveEnds(d);
  if (ends === null && kept) {
    const wall = Math.max(0, end - start) / MIN_MS;
    const nightMin = Math.min(wall, Math.max(0, kept[rule]));
    return { dayMin: wall - nightMin, nightMin };
  }
  if (ends === null) {
    const total = Math.max(0, d.durationS) / 60;
    const share = d.miles > 0 ? Math.min(1, Math.max(0, d.nightMiles / d.miles)) : 0;
    return { dayMin: total * (1 - share), nightMin: total * share };
  }
  if (!(end > start)) return { dayMin: 0, nightMin: 0 };
  const span = end - start;
  let dayMs = 0;
  let nightMs = 0;
  for (let t = start; t < end; t += MIN_MS) {
    const step = Math.min(MIN_MS, end - t);
    const mid = t + step / 2;
    const f = (mid - start) / span;
    const lat = ends.from.lat + (ends.to.lat - ends.from.lat) * f;
    const lng = ends.from.lng + (ends.to.lng - ends.from.lng) * f;
    if (isNightAt(mid, lat, lng, rule)) nightMs += step;
    else dayMs += step;
  }
  return { dayMin: dayMs / MIN_MS, nightMin: nightMs / MIN_MS };
}

/**
 * A drive's night minutes under every rule (to 0.01 min), for keeping before the archive clears its
 * position; null when it has none to judge by.
 */
export function nightByRule(d: PracticeDriveFacts): NightByRule | null {
  if (driveEnds(d) === null) return null;
  return Object.fromEntries(NIGHT_RULES.map((r) => [r, Math.round(practiceMinutes(d, r).nightMin * 100) / 100])) as NightByRule;
}
