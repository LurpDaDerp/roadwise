import type { StatSums } from '@scoring';
import { fireEvent, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { MySummary } from '@/data/server/summary';
import { encodePolyline } from '@/lib/polyline';
import { ThemeProvider } from '@/ui/theme';

import type { FinalizeTripResponse, LocalDrive, LocalDriveEvent } from '../model';

/** Mon, Oct 5 2026, 15:00 local. */
export const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime();
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const ROUTE = Array.from({ length: 30 }, (_, i) => ({ lat: 40.7 + i * 0.002, lng: -74 + (i % 7) * 0.001 }));

export function result(over: Partial<FinalizeTripResponse> = {}): FinalizeTripResponse {
  return {
    tripId: '00000000-0000-4000-8000-000000000001',
    clientTripId: '00000000-0000-4000-8000-0000000000a1',
    mergedInto: null,
    scored: true,
    reason: null,
    eventIds: [],
    rating: { safetyRating: 92.4, ranked: true },
    challenges: [],
    achievements: [],
    ...over,
  };
}

/** A 12 mi, 24 min city drive with the chances a drive like it has to slip. */
export const EXPOSURE = { slowdowns: 30, speedups: 30, turns: 24, limitS: 1200, movingS: 1300 };

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
    clean: false,
    counts: { speeding: 0, hardBrake: 1, hardAccel: 0, hardCorner: 0, eyesOff: 0, drowsy: 0 },
    result: result(),
    reason: null,
    mergedInto: null,
    syncError: null,
    endCause: null,
    watchedMiles: 0,
    origin: 'manual',
    notDrivingExpired: false,
    continuations: 0,
    startSource: null,
    exposure: { ...EXPOSURE },
    exposureEstimated: false,
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
    disputeStatus: 'none',
    disputeMessage: null,
    removed: false,
    measured: {},
    ...over,
  } as LocalDriveEvent;
}

export function sums(over: Partial<StatSums> = {}): StatSums {
  return {
    miles: 100,
    durationS: 3 * 3600,
    nightMiles: 10,
    drives: 10,
    cleanDrives: 9,
    speeding: 0,
    hardBrake: 2,
    hardAccel: 1,
    hardCorner: 0,
    ...over,
  };
}

type Summary = MySummary;

export function summary(
  over: {
    profile?: Partial<Summary['profile']>;
    progress?: Partial<Summary['progress']>;
    not_driving_left?: number;
    challenges?: Summary['challenges'];
    achievements?: string[];
  } = {}
): MySummary {
  return {
    profile: {
      user_id: 'u1',
      username: 'lurp',
      units: 'mi',
      heatmap_visibility: 'only_me',
      onboarded_at: '2026-09-01T00:00:00Z',
      share_rating: true,
      share_categories: false,
      share_achievements: false,
      share_stats: false,
      ...over.profile,
    },
    progress: {
      safety_rating: 92.4,
      ranked: true,
      miles_90d: 140,
      rating_trend: 1.5,
      ...over.progress,
    },
    not_driving_left: over.not_driving_left ?? 2,
    challenges: over.challenges ?? [
      { id: 'c1', slot: 1, title: 'Easy does it', description: '4 drives with no speeding', target: 4, progress: 4, completed: true },
      { id: 'c2', slot: 2, title: 'Smooth operator', description: '4 drives with no hard stops, starts or turns', target: 4, progress: 2, completed: false },
      { id: 'c3', slot: 3, title: 'Clean sweep', description: '3 drives with no events', target: 3, progress: 1, completed: false },
    ],
    achievements: over.achievements ?? ['first_drive'],
  } as MySummary;
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

/** A swipe control's deliberate act, as a screen reader's double-tap gives it (the gesture itself is `SwipeButton`'s own test). */
export async function swipe(el: Parameters<typeof fireEvent>[0]): Promise<void> {
  await fireEvent(el, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
}
