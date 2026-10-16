import type { StatSums } from '@scoring';
import { fireEvent, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { MySummary } from '@/data/server/summary';
import { encodePolyline } from '@/lib/polyline';
import { ThemeProvider } from '@/ui/theme';

import type { FinalizeTripResponseV3, LocalDrive, LocalDriveEvent } from '../model';

/** Mon, Oct 5 2026, 15:00 local. */
export const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime();
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const ROUTE = Array.from({ length: 30 }, (_, i) => ({ lat: 40.7 + i * 0.002, lng: -74 + (i % 7) * 0.001 }));

export function result(over: Partial<FinalizeTripResponseV3> = {}): FinalizeTripResponseV3 {
  return {
    tripId: '00000000-0000-4000-8000-000000000001',
    clientTripId: '00000000-0000-4000-8000-0000000000a1',
    mergedInto: null,
    scored: true,
    reason: null,
    breakdown: {
      scored: true,
      safeMiles: 11.8,
      creditedMiles: 11.8,
      milePoints: 118,
      cleanBonus: 0,
      streakMult: 1.2,
      dashcamMult: 1,
      mult: 1.2,
      gains: 142,
      shortScale: 1,
      events: [{ id: 'e1', penalty: 10 }],
      penalties: 10,
      net: 132,
      ratingPenalty: 10,
      activeEventCount: 1,
    },
    net: 132,
    streak: { before: 10, after: 11, outcome: 'grew', nextMult: 1.22, atRisk: false, freezes: 2, freezeEarned: false },
    progress: { points: 1240, lifetime: 1500, level: 4, levelUp: false, safetyRating: 92.4, ranked: true },
    achievements: [],
    challenges: [],
    league: { tier: 'gold', placed: true },
    ...over,
  };
}

export function drive(over: Partial<LocalDrive> = {}): LocalDrive {
  return {
    clientTripId: 'a1',
    startedAt: NOW - 2 * HOUR,
    endedAt: NOW - 2 * HOUR + 24 * 60_000,
    miles: 12,
    durationS: 24 * 60,
    nightMiles: 0,
    fromLabel: 'Home',
    toLabel: 'School',
    polyline: encodePolyline(ROUTE),
    status: 'scored',
    pointsNet: 132,
    estimate: false,
    clean: false,
    counts: { speeding: 0, pickups: 0, handlingS: 0, hardBrake: 1, hardAccel: 0, hardCorner: 0, eyesOff: 0, drowsy: 0 },
    result: result(),
    reason: null,
    mergedInto: null,
    syncError: null,
    endCause: null,
    ...over,
  } as LocalDrive;
}

export function event(over: Partial<LocalDriveEvent> = {}): LocalDriveEvent {
  return {
    id: 'e1',
    type: 'hard_brake',
    tier: 'minor',
    startedAt: NOW - 2 * HOUR + 9 * 60_000,
    durationS: 1,
    lat: ROUTE[10]!.lat,
    lng: ROUTE[10]!.lng,
    penalty: 10,
    disputeStatus: 'none',
    disputeMessage: null,
    removed: false,
    measured: {},
    stoppedInTraffic: false,
    ...over,
  };
}

export function sums(over: Partial<StatSums> = {}): StatSums {
  return {
    miles: 100,
    durationS: 3 * 3600,
    nightMiles: 10,
    drives: 10,
    cleanDrives: 9,
    speeding: 0,
    pickups: 0,
    handlingS: 0,
    hardBrake: 2,
    hardAccel: 1,
    hardCorner: 0,
    ...over,
  };
}

export function summary(over: { progress?: Partial<MySummary['progress']>; league?: Partial<MySummary['league']>; not_driving_left?: number; challenges?: MySummary['challenges'] } = {}): MySummary {
  return {
    profile: {
      user_id: 'u1',
      username: 'lurp',
      license_stage: 'intermediate',
      units: 'mi',
      state: null,
      heatmap_visibility: 'only_me',
      league_eligible: true,
      onboarded_at: '2026-09-01T00:00:00Z',
    },
    progress: {
      points: 1240,
      lifetime: 1500,
      level: 4,
      level_floor: 1500,
      level_next: 2500,
      streak: 11,
      at_risk: false,
      next_mult: 1.22,
      freezes: 2,
      clean_run: 1,
      freeze_progress: 0,
      phone_free_run: 4,
      safety_rating: 92.4,
      ranked: true,
      miles_30d: 140,
      clean_miles_30d: 120,
      rating_trend: 1.5,
      league_tier: 'gold',
      ...over.progress,
    },
    league: { week: '2026-W41', tier: 'gold', group_id: 'g1', rank: 4, size: 30, ends_at: '2026-10-12T04:00:00Z', ...over.league },
    not_driving_left: over.not_driving_left ?? 2,
    challenges: over.challenges ?? [
      { id: 'c1', slot: 1, title: 'Phone down', description: '5 drives with 0 phone pickups', target: 5, progress: 3, completed: false },
      { id: 'c2', slot: 2, title: 'Under the limit', description: '4 drives with no speeding', target: 4, progress: 4, completed: true },
      { id: 'c3', slot: 3, title: 'Clean sweep', description: '3 clean drives', target: 3, progress: 1, completed: false },
    ],
    achievements: ['first_drive'],
  };
}

export const draw = (ui: ReactElement) =>
  render(
    <ThemeProvider scheme="light" reduceMotion>
      {ui}
    </ThemeProvider>
  );

/** RNTL 14's press returns a promise; always await it. */
export async function press(el: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await fireEvent.press(el);
}
