import type { MyWrapped, SharedWrapped, WrappedArchiveEntry } from '@/data/server/wrapped';

/** October 2026: 14 drives, a Spotless Commuter with every number shown. */
export function myWrapped(over: Partial<MyWrapped> = {}): MyWrapped {
  return {
    month: '2026-10',
    drives: 14,
    miles: 212.4,
    durationS: 7 * 3600 + 20 * 60,
    avgDriveMiles: 15.2,
    longestDriveMiles: 48.3,
    avgScore: 91,
    ratingStart: 84.4,
    ratingEnd: 89.6,
    ratingChange: 5.2,
    cleanDrives: 12,
    cleanShare: 0.857,
    longestCleanDriveMiles: 31.5,
    hardPer100: 1.4,
    speedingPer100: 0.9,
    pickupsPer100: 0.5,
    categories: { speed: 92, braking: 88, acceleration: 90, turning: 86, phone: 95, attention: null },
    bestCategory: 'phone',
    busiestWeekday: 2,
    busiestBandStartHour: 6,
    weekdayDrives: 11,
    weekendDrives: 3,
    earlyShare: 0.286,
    rushShare: 0.571,
    badges: ['clean_100', 'perfect_week'],
    goalsCompleted: 5,
    archetype: { style: 'spotless', pattern: 'commuter' },
    percentiles: { miles: 72, avgScore: 64, cleanShare: 81, hardPer100: 55, speedingPer100: 40, pickupsPer100: null },
    ...over,
  };
}

/** The same month as a friend shared it. */
export function sharedWrapped(over: Partial<SharedWrapped> = {}): SharedWrapped {
  const { busiestBandStartHour: _b, weekdayDrives: _wd, weekendDrives: _we, earlyShare: _e, rushShare: _r, goalsCompleted: _g, ...core } = myWrapped();
  return { ...core, id: 'Ab3dEf7hJk9m', mine: false, username: 'maya_16', badgesCount: 2, ...over };
}

export function archiveEntry(over: Partial<WrappedArchiveEntry> = {}): WrappedArchiveEntry {
  return { month: '2026-10', drives: 14, miles: 212.4, archetype: { style: 'spotless', pattern: 'commuter' }, ...over };
}
