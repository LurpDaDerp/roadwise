/**
 * The weather heads-up before the usual commute, planned (pure). The scheduling around it is in
 * `commuteHeadsUp.ts`.
 *
 * For each commute leg (Home → Work, Work → Home, Home → School, School → Home) whose usual weekday
 * departure is known (`usualDeparture`, from the leg's own drives), the next departure D is the next
 * Monday-to-Friday at that minute on the phone's clock, at most `HEADS_UP_HORIZON_MS` away. The
 * heads-up is due `HEADS_UP_LEAD_MIN` before it (F), and only while F is still more than a minute
 * off. Quiet hours move F to their end when that is still `HEADS_UP_QUIET_GAP_MIN` before D, else
 * there is no heads-up for that departure. The forecast at the leg's start place is read over the
 * hour either side of D; the most severe danger in it is named, the mild ones (a gusty day, rain
 * after dark) never.
 *
 * Two guards against a heads-up that would be wrong:
 * - the driver's last drive ended at the leg's start place (the saved place it matched, else within
 *   `HEADS_UP_AT_START_M` and nearer it than another commute place): they are where the commute
 *   starts. A driver away from home (a trip, a night elsewhere, a car left at work) gets none for
 *   that leg;
 * - heads-ups at most one per `HEADS_UP_SPACING_MS`, the ones already shown counted: Home → School
 *   and Home → Work ten minutes apart are one heads-up (the earlier departure's), not two about the
 *   same weather.
 */
import { commuteDrives, usualDeparture, type CommuteDrive, type CommuteLegId, type CommutePlace } from '@/core/places/commute';
import { offsetMs } from '@/core/places/learn';
import { minutesOfClock, type QuietHours } from '@/features/settings/notifications/quietHours';
import { haversineMeters, type LatLng } from '@/lib/geo';

import { dangerAt, moreSevere, type DangerKind } from './danger';
import type { HourlyForecast } from './forecast';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** The heads-up comes this many minutes before the usual departure. */
export const HEADS_UP_LEAD_MIN = 30;
/** A heads-up due sooner than this from now is not scheduled (it would arrive at once, or not at all). */
export const HEADS_UP_MIN_AHEAD_MS = MIN_MS;
/** A departure further away than this is planned later (the forecast is fresher then). */
export const HEADS_UP_HORIZON_MS = 20 * HOUR_MS;
/** The forecast is read this long either side of the departure. */
export const HEADS_UP_WINDOW_MS = HOUR_MS;
/** A heads-up moved to the end of quiet hours must still come this many minutes before the departure. */
export const HEADS_UP_QUIET_GAP_MIN = 10;
/** Departures are planned Monday to Friday (0 is Sunday), as the usual departure is learned. */
export const HEADS_UP_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
/** Dangers too mild to warn about ahead of time. */
export const HEADS_UP_MILD: ReadonlySet<DangerKind> = new Set<DangerKind>(['strong_wind', 'rain_at_night']);
/** The last drive must have ended this close to the leg's start place. */
export const HEADS_UP_AT_START_M = 1_000;
/** Two heads-ups closer together than this: only the earlier departure's. */
export const HEADS_UP_SPACING_MS = 2 * HOUR_MS;

/** Every heads-up's identifier starts with this. */
export const HEADS_UP_PREFIX = 'weather-commute:';

/** One heads-up per leg: `weather-commute:home-work`. */
export const headsUpId = (leg: { from: Pick<CommutePlace, 'id'>; to: Pick<CommutePlace, 'id'> }): string => `${HEADS_UP_PREFIX}${leg.from.id}-${leg.to.id}`;

// ——— the phone's clock ———

/** The local day (days since 1970-01-01 on the zone's wall clock), its weekday (0 Sunday) and the minute of the day. */
export function localClock(t: number, tz: string): { day: number; weekday: number; minute: number } {
  const wall = t + offsetMs(t, tz);
  const day = Math.floor(wall / DAY_MS);
  return { day, weekday: new Date(day * DAY_MS).getUTCDay(), minute: Math.floor((wall - day * DAY_MS) / MIN_MS) };
}

/** The moment local day `day` shows `minute` in `tz` (across a clock change too; in a skipped hour, about it). */
export function atLocalMinute(day: number, minute: number, tz: string): number {
  const wall = day * DAY_MS + minute * MIN_MS;
  const guess = wall - offsetMs(wall, tz);
  return wall - offsetMs(guess, tz);
}

/** Whether `t` falls in quiet hours (start included, end not; a span may cross midnight; start = end is none). */
export function inQuietHours(t: number, tz: string, quiet: QuietHours | null): boolean {
  if (!quiet?.enabled) return false;
  const start = minutesOfClock(quiet.start);
  const end = minutesOfClock(quiet.end);
  if (start === null || end === null || start === end) return false;
  const m = localClock(t, tz).minute;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The first moment after `t` the clock shows the end of quiet hours, or null when they have no end. */
export function quietEndAfter(t: number, tz: string, quiet: QuietHours): number | null {
  const end = minutesOfClock(quiet.end);
  if (end === null) return null;
  const { day } = localClock(t, tz);
  for (let k = 0; k <= 2; k += 1) {
    const at = atLocalMinute(day + k, end, tz);
    if (at > t) return at;
  }
  return null;
}

/** When the heads-up for departure `departAt` is due: `HEADS_UP_LEAD_MIN` before it, moved out of quiet hours; null when quiet hours leave no time. */
export function fireTimeFor(departAt: number, tz: string, quiet: QuietHours | null): number | null {
  const fire = departAt - HEADS_UP_LEAD_MIN * MIN_MS;
  if (quiet === null || !inQuietHours(fire, tz, quiet)) return fire;
  const end = quietEndAfter(fire, tz, quiet);
  return end !== null && end <= departAt - HEADS_UP_QUIET_GAP_MIN * MIN_MS ? end : null;
}

/** The next weekday departure at `minuteOfDay` on the phone's clock whose heads-up can still come, within the horizon; null when none. */
export function nextHeadsUp(minuteOfDay: number, now: number, tz: string, quiet: QuietHours | null): { departAt: number; fireAt: number } | null {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 24 * 60) return null;
  const today = localClock(now, tz).day;
  for (let k = 0; k <= 2; k += 1) {
    const day = today + k;
    if (!HEADS_UP_WEEKDAYS.includes(new Date(day * DAY_MS).getUTCDay())) continue;
    const departAt = atLocalMinute(day, minuteOfDay, tz);
    if (departAt - now > HEADS_UP_HORIZON_MS) break;
    if (departAt <= now) continue;
    const fireAt = fireTimeFor(departAt, tz, quiet);
    if (fireAt !== null && fireAt > now + HEADS_UP_MIN_AHEAD_MS) return { departAt, fireAt };
  }
  return null;
}

// ——— the forecast ———

/** What the forecast says about a departure: the danger to name (null: none), or unknown. */
export type DepartureWeather = { known: true; kind: DangerKind | null } | { known: false };

/**
 * The most severe danger forecast for the hour either side of `departAt`, mild ones aside. Unknown
 * when there is no forecast, or it doesn't reach both sides of the departure.
 */
export function departureWeather(forecast: HourlyForecast | null, departAt: number): DepartureWeather {
  if (forecast === null) return { known: false };
  const near = forecast.points.filter((p) => {
    const t = p.sample.time * 1000;
    return t >= departAt - HEADS_UP_WINDOW_MS && t <= departAt + HEADS_UP_WINDOW_MS;
  });
  if (!near.some((p) => p.sample.time * 1000 <= departAt) || !near.some((p) => p.sample.time * 1000 >= departAt)) return { known: false };
  let kind: DangerKind | null = null;
  for (const p of near) {
    const k = dangerAt(p.sample, p.recentRainMm, p.recentSnowCm);
    if (k !== null && !HEADS_UP_MILD.has(k) && moreSevere(k, kind)) kind = k;
  }
  return { known: true, kind };
}

// ——— the legs ———

/** The driver's last drive, where it ended: the saved place it matched and its stored end point. */
export interface LastEnd {
  toPlace: string | null;
  end: LatLng | null;
}

const commutePlaceOf = (p: CommutePlace) => p.kind !== 'custom';

/**
 * Whether the last drive ended at `place`. The saved place it matched decides when it matched one
 * still saved (two places close together are never confused); else its stored end point, within
 * `HEADS_UP_AT_START_M` of `place` and no nearer another commute place (Home, Work, School).
 */
export function endedAt(last: LastEnd | null, place: CommutePlace, places: readonly CommutePlace[] = [place]): boolean {
  if (last === null) return false;
  if (last.toPlace !== null && (last.toPlace === place.id || places.some((p) => p.id === last.toPlace))) return last.toPlace === place.id;
  const end = last.end;
  if (end === null || !Number.isFinite(end.lat) || !Number.isFinite(end.lng)) return false;
  const d = haversineMeters(end, place);
  if (d > HEADS_UP_AT_START_M) return false;
  return places.every((p) => p.id === place.id || !commutePlaceOf(p) || haversineMeters(end, p) >= d);
}

export interface PlannedDeparture {
  legId: CommuteLegId;
  identifier: string;
  from: CommutePlace;
  to: CommutePlace;
  /** The usual departure (epoch ms) this heads-up is for. */
  departAt: number;
  /** When it is due (epoch ms). */
  fireAt: number;
}

export interface PlanInput {
  /** The driver's kept drives of the last `COMMUTE_WINDOW_DAYS` days (any order). */
  drives: readonly CommuteDrive[];
  places: readonly CommutePlace[];
  last: LastEnd | null;
  now: number;
  /** The phone's time zone. */
  tz: string;
  quiet: QuietHours | null;
}

/** The departures a heads-up may be planned for, soonest first (before the forecast and the spacing). */
export function planDepartures(input: PlanInput): PlannedDeparture[] {
  const out: PlannedDeparture[] = [];
  for (const leg of commuteDrives(input.drives, input.places)) {
    const usual = usualDeparture(leg.drives, input.now);
    if (usual === null || !endedAt(input.last, leg.from, input.places)) continue;
    const next = nextHeadsUp(usual.minuteOfDay, input.now, input.tz, input.quiet);
    if (next === null) continue;
    out.push({ legId: leg.id, identifier: headsUpId(leg), from: leg.from, to: leg.to, ...next });
  }
  return out.sort((a, b) => a.departAt - b.departAt);
}

/**
 * At most one heads-up per `HEADS_UP_SPACING_MS` (by when each is due), the earlier departure first.
 * `already`: when heads-ups already shown were due; a new one that close to one of them is dropped.
 */
export function spaced<T extends { departAt: number; fireAt: number }>(items: readonly T[], already: readonly number[] = []): T[] {
  const kept: T[] = [];
  const far = (a: number, b: number) => Math.abs(a - b) >= HEADS_UP_SPACING_MS;
  for (const it of [...items].sort((a, b) => a.departAt - b.departAt || a.fireAt - b.fireAt)) {
    if (already.every((t) => far(t, it.fireAt)) && kept.every((k) => far(k.fireAt, it.fireAt))) kept.push(it);
  }
  return kept;
}
