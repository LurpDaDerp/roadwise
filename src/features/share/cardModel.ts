/**
 * What a share card says (F9), as plain data. Pure: no React, no clock, no device.
 *
 * **Built from an allowlist, never a copy.** Each kind reads exactly the fields it prints — a score
 * and its band, a streak's two counts, a badge's name and tier, a class name and a count of safe
 * days, a goal's sentence — and writes them into a fresh `CardModel`. Nothing else on the input
 * (a name, a place label, a polyline, a timestamp, a user id) can reach the card, because nothing
 * copies the input wholesale.
 *
 * **Only what is settled.** A drive must be scored, `final` and synced; a badge must be earned; a
 * goal must be `achieved`; a streak must be running. Otherwise there is no card (null), and the
 * composer says what it's waiting for.
 *
 * **Dates, never times.** A date is printed as "Sep 21" from a day key (`YYYY-MM-DD`) — the trip's
 * own local day, or the day a badge was earned in the device's zone.
 *
 * **Off by default, for everyone (R-E, D10).** Distance and the invite code appear only when the
 * driver turns them on; a code that isn't a well-formed referral code is never printed.
 */
import { BADGES, LEVELS, levelFor, REFERRAL_CODE_PATTERN, type BadgeId } from '@scoring';

import type { TripSummary } from '@/data/queries/rows';
import { goalSentence, BADGE_TIER_LABEL } from '@/features/rewards/copy/common';
import { BADGE_COPY } from '@/features/rewards/copy/badges';
import type { BadgeDef, EarnedBadge, Progress, WeeklyGoal } from '@/features/rewards/api';
import { dayKey } from '@/lib/time';
import { bandLabel } from '@/ui/charts/format';

import { shareCopy as copy } from './copy';

export const CARD_KINDS = ['trip', 'streak', 'badge', 'level', 'goal'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const isCardKind = (value: unknown): value is CardKind =>
  typeof value === 'string' && (CARD_KINDS as readonly string[]).includes(value);

export interface CardToggles {
  /** A drive's distance (trip cards only). */
  distance: boolean;
  /** The driver's invite code. */
  code: boolean;
}

/** Everything off, for adults and minors alike (R-E, D10). */
export const DEFAULT_TOGGLES: CardToggles = Object.freeze({ distance: false, code: false });

export type CardInput = (
  | { kind: 'trip'; trip: TripSummary | null }
  | { kind: 'streak'; progress: Progress | null }
  | { kind: 'badge'; badgeId: string; badges: readonly EarnedBadge[]; defs: readonly BadgeDef[] }
  | { kind: 'level'; progress: Progress | null }
  | { kind: 'goal'; goals: readonly (WeeklyGoal | null)[] }
) & {
  /** The driver's own invite code, when it has been fetched (printed only with `toggles.code`). */
  inviteCode?: string | null;
  /** The zone a badge's earned date is read in (default: the device's). */
  tz?: string;
};

export interface CardModel {
  kind: CardKind;
  wordmark: 'RoadWise';
  /** What the card is: "Drive score", "Safe-day streak", "Badge", "Class", "Weekly goal reached". */
  heading: string;
  /** The largest line: a number, or a name or sentence. */
  primary: string;
  /** Printed with the primary: a band, "days", a tier. */
  unit: string | null;
  /** Smaller lines: a date, a best, a count; distance only when turned on. */
  details: string[];
  /** Only when turned on and the code is well formed. */
  code: string | null;
  /** Whether `primary` is a number (printed in the numeral face) or words. */
  numeric: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-21" → "Sep 21". A day key has no time in it to leak. */
export function dateLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return '';
  const month = MONTHS[Number(match[2]) - 1] ?? '';
  return `${month} ${Number(match[3])}`;
}

const MILE_M = 1609.344;
const miles = (m: number) => `${(m / MILE_M).toFixed(1)} mi`;

function base(kind: CardKind, fields: Omit<CardModel, 'kind' | 'wordmark' | 'code'>, input: CardInput, toggles: CardToggles): CardModel {
  const code =
    toggles.code && typeof input.inviteCode === 'string' && REFERRAL_CODE_PATTERN.test(input.inviteCode)
      ? input.inviteCode
      : null;
  return { kind, wordmark: 'RoadWise', ...fields, code };
}

/** The card for `input`, or null when there is nothing settled to share. */
export function buildCardModel(input: CardInput, toggles: CardToggles = DEFAULT_TOGGLES): CardModel | null {
  switch (input.kind) {
    case 'trip': {
      const trip = input.trip;
      if (!trip || trip.status !== 'final' || trip.syncState !== 'synced') return null;
      if (trip.score === null || trip.band === null || trip.deletedAt !== null) return null;
      const details = [dateLabel(trip.day)];
      if (toggles.distance) details.push(miles(trip.distanceM));
      return base(
        'trip',
        { heading: copy.card.trip, primary: String(Math.round(trip.score)), unit: bandLabel(trip.band), details, numeric: true },
        input,
        toggles
      );
    }
    case 'streak': {
      const days = input.progress?.streak_days ?? 0;
      if (days <= 0) return null;
      const best = Math.max(days, input.progress?.best_streak ?? 0);
      return base(
        'streak',
        { heading: copy.card.streak, primary: String(days), unit: copy.card.days(days), details: [copy.card.best(best)], numeric: true },
        input,
        toggles
      );
    }
    case 'badge': {
      const earned = input.badges.find((b) => b.badge_id === input.badgeId);
      const def = input.defs.find((d) => d.id === input.badgeId);
      const words = (BADGE_COPY as Record<string, { name: string } | undefined>)[input.badgeId];
      const known = BADGES.some((b) => b.id === (input.badgeId as BadgeId));
      if (!earned || !def || !words || !known) return null;
      const earnedDay = dayKey(new Date(earned.earned_at), input.tz);
      return base(
        'badge',
        {
          heading: copy.card.badge,
          primary: words.name,
          unit: BADGE_TIER_LABEL[def.tier],
          details: [copy.card.earned(dateLabel(earnedDay))],
          numeric: false,
        },
        input,
        toggles
      );
    }
    case 'level': {
      const progress = input.progress;
      if (!progress || progress.safe_days <= 0) return null;
      return base(
        'level',
        {
          heading: copy.card.level,
          // The server's level is the authority (it never drops); the XP table only if it's unknown.
          primary: LEVELS.find((l) => l.level === progress.level)?.name ?? levelFor(progress.xp).name,
          unit: null,
          details: [copy.card.safeDays(progress.safe_days)],
          numeric: false,
        },
        input,
        toggles
      );
    }
    case 'goal': {
      const reached = input.goals
        .filter((g): g is WeeklyGoal => g !== null && g.state === 'achieved')
        .sort((a, b) => (a.week_start < b.week_start ? 1 : -1))[0];
      if (!reached) return null;
      return base(
        'goal',
        {
          heading: copy.card.goal,
          // A prorated goal was reached on every day driven, not on the full target (T13 r1 m1):
          // it claims only the days that passed.
          primary: goalSentence(reached.category, reached.prorated ? reached.pass_days : reached.target_days),
          unit: null,
          details: reached.prorated
            ? [copy.card.everyDay, copy.card.week(dateLabel(reached.week_start))]
            : [copy.card.week(dateLabel(reached.week_start))],
          numeric: false,
        },
        input,
        toggles
      );
    }
  }
}

/** Every line the card prints, top to bottom (also what the SVG draws). */
export function cardLines(model: CardModel): string[] {
  return [
    model.wordmark,
    model.heading,
    model.primary,
    ...(model.unit ? [model.unit] : []),
    ...model.details,
    ...(model.code ? [copy.card.codeLabel, model.code] : []),
  ];
}

/**
 * The card in words: the text Android shares, the message beside the image on iOS, and the
 * preview's accessibility label.
 */
export function captionFor(model: CardModel): string {
  return [
    model.wordmark,
    `${model.heading}: ${model.primary}${model.unit ? `, ${model.unit}` : ''}`,
    ...model.details,
    ...(model.code ? [copy.card.codeLine(model.code)] : []),
  ].join('\n');
}
