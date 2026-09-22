/**
 * What one inbox row says, decided before anything is drawn. Pure: no React, no database.
 *
 * Ruling I9: a drive summary's words come from the drive's CURRENT state when the drive is on this
 * phone — its role now, its distance now, whether it would score now — never from the facts frozen
 * into the row at insert. The words themselves are the catalog's (`renderLocal`), so the inbox and
 * the notification can never disagree about how a drive is described.
 *
 * - On the phone and not deleted: the summary or the role question, a link to D1, and one line
 *   from the newest report the driver made on it, read from the stored outcome (never re-derived:
 *   `eventStanding` reads what the server settled).
 * - Deleted by the driver (the row, or its tombstone once the delete has synced): says so, no link.
 * - Not on the phone: the payload's words and date, "Not on this phone", no link — D1 would have
 *   nothing to show.
 * - A rewards notification (M5: streak, goal or challenge, class or badge, referral): the words it
 *   was pushed with (`renderInboxBase`) and a link to its rewards screen. Its subject never changes
 *   — settlement is final and value is never taken back — so nothing is re-derived.
 * - A type this build cannot render (not live, unknown, or a payload that fails its schema — a
 *   badge or challenge from a newer server included): null.
 *
 * No score anywhere: not a number, not a band.
 */
import type { Href } from 'expo-router';

import type { PermissionSnapshot } from '@/core/permissions';

import {
  tipOutcomeOf,
  toTripSummary,
  unscoredReasonOf,
  type TripDetail,
  type TripEventView,
  type TripSummary,
} from '@/data/queries';
import type { TripRow } from '@/data/db/types';
import { isAllowedHref } from '@/features/notifications/hrefs';
import { eventStanding } from '@/features/trips/detail';
import { formatClock, formatTripDate } from '@/features/trips/format';
import { tripSummaryHref } from '@/features/trips/routes';
import { dayKey } from '@/lib/time';
import {
  CATALOG,
  countsTowardDailyCap,
  LIVE_TYPES,
  PayloadSchemas,
  renderInboxBase,
  renderLocal,
  type Catalog,
  type LiveType,
  type NotificationType,
  type PermissionLapsedPayload,
} from '@/notifications/catalog';
import { CONSTANTS } from '@scoring';

import type { InboxRow } from './api';
import { inboxCopy as copy } from './copy';

/** What the phone holds about the drive a row is about. */
export interface InboxLocal {
  trip: TripDetail | null;
  events: TripEventView[];
  /** The driver deleted this drive here and the row is gone (a tombstone remembers it). */
  deleted?: boolean;
  /** This phone's permissions now, for a `permission_lapsed` row. Absent or null: not readable. */
  permissions?: PermissionsNow | null;
}

/** This install's device id and its current permission snapshot (either may be unreadable). */
export interface PermissionsNow {
  deviceId: string | null;
  snapshot: PermissionSnapshot | null;
  /**
   * Losing Always is excused now (the report's `readAlwaysExcused`, final review I4): auto-record
   * off by choice, or withdrawn. Absent or null: not known, so nothing is excused.
   */
  alwaysExcused?: boolean | null;
}

/** Whether a reported lapse still holds on this phone now. */
export type LapseNow = 'lapsed' | 'fixed' | 'unknown' | 'elsewhere' | 'excused';

/**
 * The lapse re-checked against the phone's current permissions, with the server's own rule for
 * "no longer lapsed" (0007 `subject_gone`): Always is back, any location is back, motion granted.
 * `elsewhere` when a different install id reported it (another phone, or this one before a
 * reinstall or handover) — this install's permissions say nothing about that one. `unknown` when
 * there is no reading, when this install's id cannot be read, or when motion reads "can't check".
 */
export function lapseNow(payload: PermissionLapsedPayload, current: PermissionsNow | null | undefined): LapseNow {
  if (!current || current.deviceId === null) return 'unknown';
  if (payload.deviceId !== current.deviceId) return 'elsewhere';
  if (current.snapshot === null) return 'unknown';
  const s = current.snapshot;
  switch (payload.permission) {
    case 'location_always':
      if (s.location === 'always') return 'fixed';
      // Not a fault while auto-record is off by choice or withdrawn (final review I4).
      return current.alwaysExcused === true ? 'excused' : 'lapsed';
    case 'location':
      return s.location === 'always' || s.location === 'foreground' ? 'fixed' : 'lapsed';
    case 'motion':
      return s.motion === null ? 'unknown' : s.motion === 'granted' ? 'fixed' : 'lapsed';
  }
}

export interface InboxItemView {
  id: string;
  type: LiveType;
  title: string;
  body: string;
  /** One line from the newest report on this drive, or null. */
  dispute: string | null;
  /** "Today · 7:42 AM", "Yesterday · …", "Fri, Jan 2 · …". */
  when: string;
  /** Where a tap goes, or null when there is nothing to open. */
  href: Href | null;
  /** A short fact under the body ("Not on this phone"), or null. */
  note: string | null;
  unread: boolean;
  /** The drive this row is about, for `trip_summary`. */
  clientTripId: string | null;
  /** Everything the row says, in reading order, with the unread state in words. */
  accessibilityLabel: string;
}

/** B2. Cast: the route exists (`app/(app)/permissions/index.tsx`); the catalog url is the same. */
const PERMISSIONS_HREF = '/permissions' as Href;

const isLive = (type: string): type is LiveType => (LIVE_TYPES as readonly string[]).includes(type);

/** The M5 rewards types: rendered from their payload alone. */
const REWARDS_TYPES = ['streak_milestone', 'goal_completed', 'level_up', 'referral_qualified'] as const;
type RewardsType = (typeof REWARDS_TYPES)[number];
const isRewardsType = (type: LiveType): type is RewardsType => (REWARDS_TYPES as readonly string[]).includes(type);

/** A `TripDetail` straight from a row — the loader's batch read, including a deleted row. */
export function toTripDetail(row: TripRow, scoredTripCount: number): TripDetail {
  const trip = toTripSummary(row);
  return {
    trip,
    scoredTripCount,
    stage: scoredTripCount >= CONSTANTS.LEARNING_PERIOD_TRIPS ? 'experienced' : 'new',
    tipOutcome: tipOutcomeOf(trip),
    unscoredReason: unscoredReasonOf(trip),
  };
}

/**
 * Whether this drive would be scored if the driver said *I drove*: the scoring gate re-run with
 * role `driver` (ruling T4 I2) — not discarded, not too short, not grade C.
 */
export function scorableIfDriver(trip: TripSummary): boolean {
  return unscoredReasonOf({ ...trip, role: 'driver', scored: false }) === null;
}

const DISPUTE_LINE: Partial<Record<ReturnType<typeof eventStanding>, string>> = copy.dispute;

/** The newest report's standing, in one line; null when the driver reported nothing. */
export function disputeLine(events: readonly TripEventView[]): string | null {
  let newest: { at: number; event: TripEventView } | null = null;
  for (const event of events) {
    const d = event.dispute;
    if (d === null) continue;
    const at = d.decidedAt ?? d.submittedAt;
    if (newest === null || at >= newest.at) newest = { at, event };
  }
  return newest === null ? null : (DISPUTE_LINE[eventStanding(newest.event)] ?? null);
}

/** "Today · 7:42 AM" in `tz`. */
export function whenLabel(ms: number, now: number, tz: string): string {
  const day = safeDayKey(ms, tz);
  const label =
    day === safeDayKey(now, tz)
      ? copy.today
      : day === safeDayKey(now - 86_400_000, tz)
        ? copy.yesterday
        : formatTripDate(ms, tz);
  return `${label} · ${formatClock(ms, tz)}`;
}

function safeDayKey(ms: number, tz: string): string {
  try {
    return dayKey(new Date(ms), tz);
  } catch {
    return dayKey(new Date(ms));
  }
}

function labelOf(v: Omit<InboxItemView, 'accessibilityLabel'>): string {
  const parts = [v.unread ? `${copy.unread}.` : null, `${v.title}.`, v.body, v.dispute, v.note ? `${v.note}.` : null, v.when];
  return parts.filter((p): p is string => p !== null && p.length > 0).join(' ');
}

function finish(v: Omit<InboxItemView, 'accessibilityLabel'>): InboxItemView {
  return { ...v, accessibilityLabel: labelOf(v) };
}

export function toItemView(row: InboxRow, local: InboxLocal, now: number, tz: string): InboxItemView | null {
  if (!isLive(row.type)) return null;
  const common = { id: row.id, type: row.type, unread: row.read_at === null };

  if (row.type === 'permission_lapsed') {
    const base = renderInboxBase('permission_lapsed', row.payload);
    const lapse = PayloadSchemas.permission_lapsed.safeParse(row.payload);
    if (base === null || !lapse.success) return null;
    const at = Date.parse(row.created_at);
    const state = lapseNow(lapse.data, local.permissions);
    const words =
      state === 'lapsed'
        ? base
        : state === 'excused'
          ? { title: copy.lapse.excused.title, body: copy.lapse.excused.body(formatTripDate(at, tz)) }
          : (() => {
            const c = copy.lapse[state][lapse.data.permission];
            return { title: c.title, body: c.body(formatTripDate(at, tz)) };
          })();
    return finish({
      ...common,
      title: words.title,
      body: words.body,
      dispute: null,
      when: whenLabel(at, now, tz),
      href: PERMISSIONS_HREF,
      note: null,
      clientTripId: null,
    });
  }

  if (isRewardsType(row.type)) {
    const base = renderInboxBase(row.type, row.payload);
    if (base === null) return null;
    return finish({
      ...common,
      title: base.title,
      body: base.body,
      dispute: null,
      when: whenLabel(Date.parse(row.created_at), now, tz),
      // The catalog's url is one of the allowlisted rewards routes; anything else opens nothing.
      href: isAllowedHref(base.url) ? (base.url as Href) : null,
      note: null,
      clientTripId: null,
    });
  }

  const payload = PayloadSchemas.trip_summary.safeParse(row.payload);
  if (!payload.success) return null;
  const facts = payload.data;
  const trip = local.trip?.trip ?? null;

  if (local.deleted === true || (trip !== null && trip.deletedAt !== null)) {
    return finish({
      ...common,
      title: copy.deleted.title,
      body: copy.deleted.body,
      dispute: null,
      when: whenLabel(trip?.startedAt ?? Date.parse(facts.startedAt), now, tz),
      href: null,
      note: null,
      clientTripId: facts.clientTripId,
    });
  }

  if (trip === null) {
    const mi = milesLabel(facts.distanceM);
    return finish({
      ...common,
      title: copy.elsewhere.title,
      body: mi === null ? copy.elsewhere.bodyNoDistance : copy.elsewhere.body(mi),
      dispute: null,
      when: whenLabel(Date.parse(facts.startedAt), now, tz),
      href: null,
      note: copy.notOnPhone,
      clientTripId: facts.clientTripId,
    });
  }

  const current = renderLocal('trip_summary', {
    clientTripId: trip.clientTripId,
    distanceM: trip.distanceM,
    roleUnknown: trip.role === 'unknown',
    scorableIfDriver: scorableIfDriver(trip),
    count: 1,
  });
  return finish({
    ...common,
    title: current.title,
    body: current.body,
    dispute: disputeLine(local.events),
    when: whenLabel(trip.startedAt, now, tz),
    href: tripSummaryHref(trip.clientTripId),
    note: null,
    clientTripId: trip.clientTripId,
  });
}

/**
 * Miles as the catalog prints them (its `miles()` is private to the synced catalog): one decimal
 * under ten, whole miles from ten; null under 0.05 mi, where no distance is worth naming.
 */
export function milesLabel(distanceM: number): string | null {
  const mi = distanceM / 1609.344;
  if (!Number.isFinite(mi) || mi < 0.05) return null;
  return mi < 9.95 ? mi.toFixed(1) : String(Math.round(mi));
}

/** Rows the list shows: not dismissed. */
export const isVisibleRow = (row: InboxRow): boolean => row.dismissed_at === null;

/**
 * The server's half of the §11.1 daily cap: rows `push-sender` pushed during the user's local day
 * in `tz`, counted only when their type counts toward the cap — decided by the catalog
 * (`countsTowardDailyCap`, so a `transactional` summary is exempt), never by comparing against
 * `family`. A type this build does not know is counted: for a cap, over-counting only holds a
 * notification back; under-counting would let a third one through. Dismissed rows count too.
 */
export function countServerPushesToday(
  rows: readonly InboxRow[],
  tz: string,
  now: number,
  catalog: Catalog = CATALOG
): number {
  const today = safeDayKey(now, tz);
  let count = 0;
  for (const row of rows) {
    if (row.pushed_at === null) continue;
    if (safeDayKey(Date.parse(row.pushed_at), tz) !== today) continue;
    const known = Object.prototype.hasOwnProperty.call(catalog, row.type);
    if (known && !countsTowardDailyCap(row.type as NotificationType, catalog)) continue;
    count += 1;
  }
  return count;
}
