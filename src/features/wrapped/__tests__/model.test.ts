import { PixelRatio, Platform } from 'react-native';

import { drive } from '@/features/drives/__fixtures__/drives';

import { archiveEntry } from '../__fixtures__/wrapped';
import { bandLabel, percent, percentileText, rateParts, rateText, ratingChangeText, ratingText, storySlides, weekdayName } from '../format';
import { homeCardEntry, inCardWindow, monthName, monthOf, monthYear, previousMonth } from '../month';
import { wrappedPlaces } from '../places';
import { exportSize } from '../share';

jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const NY = 'America/New_York';
/** A local hour in New York on a day of 2026 (EDT, UTC-4, through Nov 1 at 2 AM; EST after). */
const ny = (m: number, d: number, h = 12) => Date.UTC(2026, m - 1, d, h + (m > 11 || (m === 11 && d > 1) ? 5 : 4));

describe('months', () => {
  test('names, the month before, and the month of a moment in its own zone', () => {
    expect(monthName('2026-10')).toBe('October');
    expect(monthYear('2026-01')).toBe('January 2026');
    expect(monthName('2026-13')).toBe('');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-10')).toBe('2026-09');
    // 23:30 on Oct 31 in Los Angeles is already Nov 1 in UTC and in Tokyo.
    const t = Date.UTC(2026, 10, 1, 6, 30);
    expect(monthOf(t, 'America/Los_Angeles')).toBe('2026-10');
    expect(monthOf(t, 'Asia/Tokyo')).toBe('2026-11');
  });

  test("Home's card: the 1st through the 7th, last month's line only, until closed for that month", () => {
    const archive = [archiveEntry({ month: '2026-10' }), archiveEntry({ month: '2026-08' })];
    expect(inCardWindow(ny(11, 1, 0), NY)).toBe(true);
    expect(inCardWindow(ny(11, 7, 23), NY)).toBe(true);
    expect(inCardWindow(ny(11, 8, 0), NY)).toBe(false);
    expect(homeCardEntry(ny(11, 1), NY, archive, null)?.month).toBe('2026-10');
    expect(homeCardEntry(ny(11, 7), NY, archive, null)?.month).toBe('2026-10');
    expect(homeCardEntry(ny(11, 8), NY, archive, null)).toBeNull();
    // Closed this month; a card closed last month doesn't hide this one.
    expect(homeCardEntry(ny(11, 3), NY, archive, '2026-10')).toBeNull();
    expect(homeCardEntry(ny(11, 3), NY, archive, '2026-09')?.month).toBe('2026-10');
    // No Wrapped for last month (under 3 scored drives): nothing, even with older ones.
    expect(homeCardEntry(ny(10, 2), NY, archive, null)).toBeNull();
    expect(homeCardEntry(ny(11, 2), NY, undefined, null)).toBeNull();
    // January shows December's.
    expect(homeCardEntry(Date.UTC(2027, 0, 2, 17), NY, [archiveEntry({ month: '2026-12' })], null)?.month).toBe('2026-12');
  });
});

describe('numbers in words', () => {
  test('weekdays and 3-hour bands', () => {
    expect(weekdayName(1)).toBe('Monday');
    expect(weekdayName(7)).toBe('Sunday');
    expect(weekdayName(0)).toBe('');
    expect([0, 3, 6, 9, 12, 15, 18, 21].map(bandLabel)).toEqual(['midnight–3 AM', '3–6 AM', '6–9 AM', '9 AM–noon', 'noon–3 PM', '3–6 PM', '6–9 PM', '9 PM–midnight']);
    expect(bandLabel(4)).toBe('');
  });

  test("shares, and rates in the driver's units", () => {
    expect(percent(0.857)).toBe('86%');
    expect(percent(0)).toBe('0%');
    expect(rateText(1.4, 'mi')).toBe('1.4 per 100 mi');
    expect(rateText(0, 'mi')).toBe('0.0 per 100 mi');
    // 1.6 per 100 mi is 1.0 per 100 km.
    expect(rateParts(1.6, 'km')).toEqual({ value: '1.0', per: 'per 100 km' });
  });

  test('"Better than": miles say "More miles than"; under 10 or none is never said', () => {
    expect(percentileText('avgScore', 72)).toBe('Better than 72% of drivers');
    expect(percentileText('hardPer100', 100)).toBe('Better than 100% of drivers');
    expect(percentileText('miles', 81)).toBe('More miles than 81% of drivers');
    expect(percentileText('cleanShare', 9)).toBeNull();
    expect(percentileText('cleanShare', 10)).toBe('Better than 10% of drivers');
    expect(percentileText('pickupsPer100', null)).toBeNull();
  });

  test('the Safety Rating and its change, between the whole numbers shown', () => {
    expect(ratingText(89.6)).toBe('90');
    expect(ratingText(null)).toBe('No rating yet');
    expect(ratingChangeText(84.4, 89.6, 'October')).toBe('Up 6 since October 1');
    expect(ratingChangeText(90.2, 88.4, 'October')).toBe('Down 2 since October 1');
    expect(ratingChangeText(88.6, 89.4, 'October')).toBe('Same as on October 1');
    expect(ratingChangeText(null, 89.4, 'October')).toBeNull();
    expect(ratingChangeText(80, null, 'October')).toBeNull();
  });
});

describe('the slides', () => {
  const places = { pair: { from: 'Home', to: 'Work', drives: 6 }, commuteDrives: 8 };
  test('the own story: all ten with a trip and some progress', () => {
    expect(storySlides('own', { badges: 2, goals: 5, places })).toEqual(['intro', 'totals', 'safety', 'smoothness', 'phoneSpeed', 'habits', 'places', 'progress', 'archetype', 'summary']);
  });
  test('Places is skipped without a most-driven trip; Progress with no badge and no goal', () => {
    expect(storySlides('own', { badges: 0, goals: 0, places: { pair: null, commuteDrives: 3 } })).toEqual(['intro', 'totals', 'safety', 'smoothness', 'phoneSpeed', 'habits', 'archetype', 'summary']);
    expect(storySlides('own', { badges: 0, goals: 1, places: null })).toContain('progress');
  });
  test('a shared copy never has Places; Progress only with a badge', () => {
    expect(storySlides('shared', { badges: 0, goals: 4, places })).toEqual(['intro', 'totals', 'safety', 'smoothness', 'phoneSpeed', 'habits', 'archetype', 'summary']);
    expect(storySlides('shared', { badges: 1, goals: 0, places: null })).toContain('progress');
  });
});

describe("Places, from this phone's drives", () => {
  const PLACES = [
    { id: 'home', kind: 'home' as const, name: 'Home', lat: 40.7, lng: -74 },
    { id: 'work', kind: 'work' as const, name: 'Work', lat: 40.76, lng: -73.98 },
  ];
  const d = (id: string, day: number, from: string | null, to: string | null, over: Parameters<typeof drive>[0] = {}) =>
    drive({ clientTripId: id, startedAt: ny(10, day), tz: NY, fromLabel: from, toLabel: to, fromPlace: null, toPlace: null, start: undefined, end: undefined, ...over });

  test('the most-driven trip (2 or more), a tie to the most recent; unknown labels never count', () => {
    const drives = [
      d('a', 2, 'Home', 'Gym'),
      d('b', 3, 'Home', 'Gym'),
      d('c', 4, 'Home', 'School'),
      d('d', 9, 'Home', 'School'),
      d('e', 10, null, 'School'),
      d('f', 11, null, 'School'),
    ];
    expect(wrappedPlaces(drives, '2026-10', []).pair).toEqual({ from: 'Home', to: 'School', drives: 2 });
    expect(wrappedPlaces([...drives, d('g', 12, 'Home', 'Gym')], '2026-10', []).pair).toEqual({ from: 'Home', to: 'Gym', drives: 3 });
  });

  test("only the month's scored, kept drives; one drive of a trip is not enough", () => {
    const drives = [
      d('a', 2, 'Home', 'Gym'),
      d('b', 3, 'Home', 'Gym', { status: 'not_driving' as never }),
      d('c', 4, 'Home', 'Gym', { archived: true }),
      // Oct 31 in Los Angeles, Nov 1 in Tokyo: a Tokyo drive is November's.
      drive({ clientTripId: 'x', startedAt: Date.UTC(2026, 10, 1, 6, 30), tz: 'Asia/Tokyo', fromLabel: 'Home', toLabel: 'Gym' }),
    ];
    expect(wrappedPlaces(drives, '2026-10', []).pair).toBeNull();
  });

  test("commute drives: the month's drives on a Home and Work leg", () => {
    const drives = [
      d('a', 5, 'Home', 'Work', { fromPlace: 'home', toPlace: 'work' }),
      d('b', 5, 'Work', 'Home', { fromPlace: 'work', toPlace: 'home' }),
      d('c', 6, 'Home', 'Work', { fromPlace: 'home', toPlace: 'work' }),
      d('d', 6, 'Home', 'Gym', { fromPlace: 'home', toPlace: null }),
    ];
    expect(wrappedPlaces(drives, '2026-10', PLACES)).toEqual({ pair: { from: 'Home', to: 'Work', drives: 2 }, commuteDrives: 3 });
    expect(wrappedPlaces(drives, '2026-10', []).commuteDrives).toBe(0);
  });
});

describe('the shared image', () => {
  afterEach(() => jest.restoreAllMocks());

  test('comes out at 1080 × 1920 pixels: iOS takes the size in points, Android in pixels', () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
    const os = Platform.OS;
    try {
      Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
      expect(exportSize()).toEqual({ width: 360, height: 640 });
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
      expect(exportSize()).toEqual({ width: 1080, height: 1920 });
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    }
  });
});
