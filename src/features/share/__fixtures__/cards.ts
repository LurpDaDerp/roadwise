/**
 * Leaky card inputs for the privacy tests: every kind, each carrying things a careless build could
 * copy onto a card — a name, a birth date, a user id, place labels, a polyline and a geohash.
 */
import { tripRow } from '@/data/queries/__fixtures__/rows';
import { toTripSummary } from '@/data/queries/rows';
import { badgeDefRows, badgeRow, goalRow, progressRow, UID } from '@/features/rewards/__fixtures__/rows';

import type { CardInput, CardKind } from '../cardModel';

export const NAME = 'Avery Quinn';
export const BIRTH = '2009-04-17';
export const PLACE = 'Near Lincoln HS';
/** Strings that must never be on a card, whatever the toggles. */
export const LEAKS = [NAME, BIRTH, PLACE, 'Near Home', UID, '_p~iF', '9q8yy'];

export const finalTrip = (over: Parameters<typeof tripRow>[0] = {}) =>
  toTripSummary(
    tripRow({
      status: 'final',
      sync_state: 'synced',
      score: 92,
      started_at: Date.parse('2026-09-21T23:47:00Z'),
      tz: 'America/Los_Angeles',
      start_label: 'Near Home',
      end_label: PLACE,
      polyline: '_p~iF~ps|U_ulLnnqC',
      start_geohash5: '9q8yy',
      ...over,
    })
  );

const leaky = { name: NAME, birthDate: BIRTH, user_id: UID } as Record<string, unknown>;

export const INPUTS: Record<CardKind, CardInput> = {
  trip: { kind: 'trip', trip: finalTrip(), ...leaky },
  streak: { kind: 'streak', progress: progressRow({ streak_days: 12, best_streak: 30 }), ...leaky },
  badge: {
    kind: 'badge',
    badgeId: 'safe_days_7',
    badges: [badgeRow('safe_days_7', { earned_at: '2026-09-21T06:15:00+00:00' })],
    defs: badgeDefRows(),
    tz: 'UTC',
    ...leaky,
  },
  level: { kind: 'level', progress: progressRow({ xp: 4200, level: 3, safe_days: 42 }), ...leaky },
  goal: {
    kind: 'goal',
    goals: [goalRow('2026-09-21'), goalRow('2026-09-14', { state: 'achieved', pass_days: 4, category: 'braking' })],
    ...leaky,
  },
} as Record<CardKind, CardInput>;
