import { keepItUpTip, pickTopTip } from '@/content/tips';
import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { normalizeTripsFilter } from '@/data/queries/keys';
import {
  isHiddenTrip,
  toScorableEvent,
  toScorableEvents,
  toScoredTrip,
  isScoredRow,
  matchesTripsFilter,
  pageOf,
  parseCategoryDeductions,
  sortTripsNewestFirst,
  tipOutcomeOf,
  toDayEntry,
  toTripEventView,
  toTripSummary,
  unscoredReasonOf,
} from '@/data/queries/rows';

const summary = (over: Parameters<typeof tripRow>[0] = {}) => toTripSummary(tripRow(over));

describe('toTripSummary', () => {
  test('maps a scored row to the shape D1 and D4 read', () => {
    const trip = summary({
      category_deductions_json: JSON.stringify(deductions({ speeding: 6, braking: 4 })),
      score: 90,
      incomplete: 1,
    });

    expect(trip).toMatchObject({
      clientTripId: 'trip-1',
      day: '2026-01-05',
      role: 'driver',
      scored: true,
      score: 90,
      band: 'excellent',
      dataQuality: 'A',
      worstCategory: 'speeding',
      deduction: 10,
      incomplete: true,
      pendingSync: true,
      conditions: { night: false, precipitation: false, hadSevereEvent: false },
    });
  });

  test('the local day comes from the trip own zone, not the device', () => {
    // 2026-01-06T01:00Z is still 2026-01-05 in Los Angeles.
    const trip = summary({ started_at: Date.UTC(2026, 0, 6, 1, 0, 0), tz: 'America/Los_Angeles' });
    expect(trip.day).toBe('2026-01-05');
  });

  test('a truncated deductions column reads as all zeros, and the rest of the row survives', () => {
    const trip = summary({ category_deductions_json: '{"speeding": 4, "brak' });
    expect(trip.categoryDeductions).toEqual(deductions());
    expect(trip.worstCategory).toBeNull();
    expect(trip.score).toBe(90);
  });

  test('a non-finite deduction is floored to zero rather than poisoning every sum', () => {
    expect(parseCategoryDeductions('{"phone": null, "speeding": -3}')).toEqual(deductions());
  });

  test('two categories that cost the same resolve to the one with the larger cap', () => {
    // phone caps at 30, speeding at 25: the costlier category is the one worth coaching.
    const trip = summary({
      category_deductions_json: JSON.stringify(deductions({ speeding: 5, phone: 5 })),
    });
    expect(trip.worstCategory).toBe('phone');
  });

  test('a synced trip is not pending, and a failed one carries the server code', () => {
    expect(summary({ sync_state: 'synced', server_id: 'srv-1' }).pendingSync).toBe(false);
    expect(summary({ sync_state: 'failed', sync_error: 'trip_too_old' })).toMatchObject({
      pendingSync: false,
      syncError: 'trip_too_old',
    });
  });

  test('an unknown role falls back to unknown rather than leaking the stored string', () => {
    expect(summary({ role: 'co-pilot' }).role).toBe('unknown');
    expect(summary({ role: null }).role).toBe('unknown');
  });
});

describe('isScoredRow', () => {
  test('a provisional trip with a score counts as scored; the server only confirms it', () => {
    expect(isScoredRow(tripRow({ status: 'provisional', score: 88 }))).toBe(true);
    expect(isScoredRow(tripRow({ status: 'final', score: 88 }))).toBe(true);
  });

  test('unscored, discarded, recording and a missing score do not', () => {
    expect(isScoredRow(tripRow({ status: 'unscored', score: null }))).toBe(false);
    expect(isScoredRow(tripRow({ status: 'discarded', score: null }))).toBe(false);
    expect(isScoredRow(tripRow({ status: 'recording', score: null }))).toBe(false);
    expect(isScoredRow(tripRow({ status: 'provisional', score: null }))).toBe(false);
  });
});

describe('matchesTripsFilter', () => {
  test('a recording trip is never listed, whatever the filter says', () => {
    const recording = summary({ status: 'recording', score: null });
    expect(isHiddenTrip(recording)).toBe(true);
    expect(matchesTripsFilter(recording, { includeDiscarded: true })).toBe(false);
  });

  test('a discarded trip is hidden by default and returned on request', () => {
    const discarded = summary({ status: 'discarded', score: null });
    expect(matchesTripsFilter(discarded)).toBe(false);
    expect(matchesTripsFilter(discarded, { includeDiscarded: true })).toBe(true);
  });

  test('role, band and scoredOnly each narrow the list', () => {
    const trip = summary({ score: 82 });
    expect(matchesTripsFilter(trip, { role: 'driver' })).toBe(true);
    expect(matchesTripsFilter(trip, { role: 'passenger' })).toBe(false);
    expect(matchesTripsFilter(trip, { band: 'good' })).toBe(true);
    expect(matchesTripsFilter(trip, { band: 'excellent' })).toBe(false);
    const unscored = summary({ status: 'unscored', score: null });
    expect(matchesTripsFilter(unscored, { scoredOnly: true })).toBe(false);
    expect(matchesTripsFilter(unscored)).toBe(true);
  });

  test('the category filter keeps only trips that category actually cost points', () => {
    const cost = summary({
      category_deductions_json: JSON.stringify(deductions({ speeding: 4 })),
    });
    const clean = summary();
    expect(matchesTripsFilter(cost, { category: 'speeding' })).toBe(true);
    expect(matchesTripsFilter(clean, { category: 'speeding' })).toBe(false);
  });

  test('the date range is inclusive at both ends', () => {
    const trip = summary();
    expect(matchesTripsFilter(trip, { from: T0, to: T0 })).toBe(true);
    expect(matchesTripsFilter(trip, { from: T0 + 1 })).toBe(false);
    expect(matchesTripsFilter(trip, { to: T0 - 1 })).toBe(false);
  });
});

describe('paging', () => {
  const trips = [
    summary({ client_trip_id: 'a', started_at: T0 }),
    summary({ client_trip_id: 'b', started_at: T0 + 1000 }),
    summary({ client_trip_id: 'c', started_at: T0 + 2000 }),
  ];

  test('newest first, ties broken by id', () => {
    expect(sortTripsNewestFirst(trips).map((t) => t.clientTripId)).toEqual(['c', 'b', 'a']);
  });

  test('limit and offset page the filtered list, not the table', () => {
    const ordered = sortTripsNewestFirst(trips);
    expect(pageOf(ordered, { limit: 2 }).map((t) => t.clientTripId)).toEqual(['c', 'b']);
    expect(pageOf(ordered, { limit: 2, offset: 2 }).map((t) => t.clientTripId)).toEqual(['a']);
    expect(pageOf(ordered, {}).map((t) => t.clientTripId)).toEqual(['c', 'b', 'a']);
  });
});

describe('why a trip has no score, and which card D1 shows', () => {
  test('a scored trip has no reason', () => {
    expect(unscoredReasonOf(summary())).toBeNull();
  });

  test('discarded reads as implausible speed before anything else', () => {
    const trip = summary({ status: 'discarded', score: null, role: 'passenger' });
    expect(unscoredReasonOf(trip)).toBe('implausible_speed');
  });

  test('an unclear role is asked about, never blamed on the driver or called a passenger trip', () => {
    // An auto-detected drive uploads as role 'unknown' and the scorer leaves it unscored as
    // `role_unknown` (§9.7); `toTripSummary` also maps a null or unrecognised `role` column to
    // 'unknown'. Either way the row records nothing about who was driving, so the reason is the
    // one whose copy asks C10's question instead of asserting an answer.
    const auto = summary({ status: 'unscored', score: null, role: 'unknown' });
    expect(unscoredReasonOf(auto)).toBe('role_unknown');
    const unknown = summary({ status: 'unscored', score: null, role: null });
    expect(unknown.role).toBe('unknown');
    expect(unscoredReasonOf(unknown)).toBe('role_unknown');
    // In the scorer's order: an unclear role comes before the trip's length
    expect(
      unscoredReasonOf(
        summary({ status: 'unscored', score: null, role: 'unknown', distance_m: 100, duration_s: 60 })
      )
    ).toBe('role_unknown');
    // and a discarded drive is still implausible first
    expect(unscoredReasonOf(summary({ status: 'discarded', score: null, role: 'unknown' }))).toBe(
      'implausible_speed'
    );
    // `toScoredTrip` carries the same reason, so the coaching layer sees an unscored trip
    expect(toScoredTrip(auto, []).reason).toBe('role_unknown');
    expect(tipOutcomeOf(auto)).toBe('facts_only');
  });

  test('a passenger, a short trip and grade C each explain themselves', () => {
    expect(unscoredReasonOf(summary({ status: 'unscored', score: null, role: 'passenger' }))).toBe(
      'passenger'
    );
    expect(
      unscoredReasonOf(summary({ status: 'unscored', score: null, distance_m: 100, duration_s: 60 }))
    ).toBe('too_short');
    expect(unscoredReasonOf(summary({ status: 'unscored', score: null, data_quality: 'C' }))).toBe(
      'grade_c'
    );
  });

  test('a row with no data quality is not called grade C: the scorer always writes one', () => {
    expect(
      unscoredReasonOf(summary({ status: 'unscored', score: null, data_quality: null }))
    ).toBeNull();
  });

  test('the three D1 variants are distinguishable', () => {
    expect(
      tipOutcomeOf(summary({ category_deductions_json: JSON.stringify(deductions({ phone: 3 })) }))
    ).toBe('coach');
    // A scored trip that cost nothing: pickTopTip returns null, and keepItUpTip is the card.
    expect(tipOutcomeOf(summary({ score: 100 }))).toBe('keep_it_up');
    // No score at all: pickTopTip also returns null, but there is nothing to coach.
    expect(tipOutcomeOf(summary({ status: 'unscored', score: null }))).toBe('facts_only');
  });
});

describe('toTripEventView', () => {
  test('parses the stored strings the engine wrote', () => {
    const view = toTripEventView(eventRow());
    expect(view).toMatchObject({
      id: 'event-1',
      category: 'speeding',
      severity: 3.5,
      deduction: 6,
      status: 'scored',
      affectsScore: true,
      possible: false,
      alertShown: true,
      corrected: false,
      measured: { speedMps: 21, limitMps: 15.6, overMps: 5.4 },
      context: { night: false, precipitation: false },
    });
  });

  test('a possible event is labelled and never counted against the score', () => {
    const view = toTripEventView(eventRow({ status: 'possible', deduction: null }));
    expect(view).toMatchObject({ possible: true, affectsScore: false, deduction: 0 });
  });

  test('a scored event with no deduction does not claim to affect the score', () => {
    expect(toTripEventView(eventRow({ deduction: 0 })).affectsScore).toBe(false);
  });

  test('a category this build does not know is kept raw rather than guessed at', () => {
    const view = toTripEventView(eventRow({ category: 'tailgating' }));
    expect(view.category).toBeNull();
    expect(view.rawCategory).toBe('tailgating');
  });
});

describe('toDayEntry', () => {
  const dayRow = {
    day: '2026-01-05',
    longTermScore: 86,
    band: 'good',
    provisional: false,
    safeDay: true,
    goodDay: false,
    phoneFreeDay: true,
    cameraDay: false,
    exposure: 2.5,
    drivingS: 3600,
    tripsScored: 2,
    severeEvents: 0,
  };

  test('reads the cached day and recomputes its points from the flags', () => {
    const entry = toDayEntry({ day: '2026-01-05', payload: dayRow, updated_at: T0 });
    expect(entry).toMatchObject({
      day: '2026-01-05',
      safeDay: true,
      phoneFreeDay: true,
      cameraDay: false,
      // 50 for the safe day + 25 for the phone-free day; a good day is exclusive with a safe one.
      points: 75,
      longTermScore: 86,
      band: 'good',
      provisional: false,
      tripsScored: 2,
      unreadable: false,
    });
  });

  test('tripsAll is read when the day carries it, and null for an older payload', () => {
    expect(toDayEntry({ day: '2026-01-05', payload: { ...dayRow, tripsAll: 3 }, updated_at: T0 }).tripsAll).toBe(3);
    expect(toDayEntry({ day: '2026-01-05', payload: dayRow, updated_at: T0 }).tripsAll).toBeNull();
  });

  test('an array payload is read as the day rows the server sends', () => {
    const entry = toDayEntry({ day: '2026-01-05', payload: [dayRow], updated_at: null });
    expect(entry.safeDay).toBe(true);
    expect(entry.unreadable).toBe(false);
  });

  test('a payload this build cannot read degrades to no badges, not to a broken screen', () => {
    const entry = toDayEntry({ day: '2026-01-05', payload: '2026-01-05', updated_at: T0 });
    expect(entry).toMatchObject({
      day: '2026-01-05',
      safeDay: false,
      goodDay: false,
      points: 0,
      longTermScore: null,
      band: null,
      unreadable: true,
    });
  });

  test('a good day scores 20, and an unknown band is dropped', () => {
    const entry = toDayEntry({
      day: '2026-01-06',
      payload: { ...dayRow, safeDay: false, goodDay: true, cameraDay: true, band: 'brilliant' },
      updated_at: T0,
    });
    expect(entry.points).toBe(20 + 25 + 10);
    expect(entry.band).toBeNull();
  });
});

describe('normalizeTripsFilter', () => {
  test('drops undefined keys and fixes the order, so two spellings hash alike', () => {
    const normalized = normalizeTripsFilter({ limit: 5, role: 'driver', from: undefined });
    expect(Object.keys(normalized)).toEqual(['role', 'limit']);
    expect(normalized).toEqual({ role: 'driver', limit: 5 });
    expect(JSON.stringify(normalizeTripsFilter({ role: 'driver', limit: 5 }))).toBe(
      JSON.stringify(normalized)
    );
  });

  test('an empty filter normalizes to an empty object, not to undefined', () => {
    expect(normalizeTripsFilter()).toEqual({});
  });
});

describe('the scorer bridge (rows -> @scoring -> pickTopTip)', () => {
  const speedingEvent = eventRow({ id: 'e1', category: 'speeding', status: 'scored', deduction: 6 });
  const scoredTrip = summary({
    status: 'provisional',
    sync_state: 'queued',
    score: 90,
    category_deductions_json: JSON.stringify(deductions({ speeding: 6, braking: 4 })),
  });

  test('a locally provisional trip is the scorer\'s final — the rule the whole card rests on', () => {
    // finalizeTrip stores every scored trip as `provisional` until the server confirms it, which
    // is the state D1 always shows after a drive. `pickTopTip` refuses anything but 'final'.
    expect(toScoredTrip(scoredTrip).status).toBe('final');
    expect(toScoredTrip(summary({ status: 'final', score: 90 })).status).toBe('final');
  });

  test('unscored and discarded map to themselves and carry the reason', () => {
    const passenger = summary({ status: 'unscored', score: null, role: 'passenger' });
    expect(toScoredTrip(passenger)).toMatchObject({
      status: 'unscored',
      score: null,
      reason: 'passenger',
    });
    expect(toScoredTrip(summary({ status: 'discarded', score: null }))).toMatchObject({
      status: 'discarded',
      reason: 'implausible_speed',
    });
  });

  test('only events that cost points reach eventDeductions', () => {
    const possible = toTripEventView(eventRow({ id: 'e2', status: 'possible', deduction: null }));
    const scored = toTripEventView(speedingEvent);
    const bridged = toScoredTrip(scoredTrip, [scored, possible]);
    // Exactly one key: a `possible` event that cost nothing must not appear at all, or
    // `worstSeverity` would weigh an event the driver was never charged for.
    expect(bridged.eventDeductions).toEqual({ e1: 6 });
    expect(bridged).toMatchObject({
      categoryDeductions: deductions({ speeding: 6, braking: 4 }),
      exposure: 1,
      dataQuality: 'A',
      scoringVersion: 1,
    });
  });

  test('toScorableEvent keeps what the scorer reads and drops what it cannot score', () => {
    expect(toScorableEvent(toTripEventView(speedingEvent))).toEqual({
      id: 'e1',
      category: 'speeding',
      startedAt: speedingEvent.started_at,
      durationS: 38,
      q: 0.9,
      corrected: false,
      status: 'scored',
      measured: { speedMps: 21, limitMps: 15.6, overMps: 5.4 },
      context: { night: false, precipitation: false },
    });
    // A category or a status this build has no band for cannot be scored against.
    expect(toScorableEvent(toTripEventView(eventRow({ category: 'tailgating' })))).toBeNull();
    expect(toScorableEvent(toTripEventView(eventRow({ status: null })))).toBeNull();
    // No confidence recorded is not the same as certain.
    expect(toScorableEvent(toTripEventView(eventRow({ confidence: null })))?.q).toBe(0);
    expect(toScorableEvents([toTripEventView(eventRow({ category: 'tailgating' }))])).toEqual([]);
  });

  test('a freshly finalized, unsynced trip still gets its coaching tip', () => {
    const events = [toTripEventView(speedingEvent)];
    const tip = pickTopTip(toScoredTrip(scoredTrip, events), toScorableEvents(events), 'new');

    expect(tipOutcomeOf(scoredTrip)).toBe('coach');
    expect(tip).not.toBeNull();
    expect(tip?.category).toBe('speeding');
  });

  test('a clean scored trip yields no tip, which is the keep-it-up card', () => {
    const clean = summary({ status: 'provisional', score: 100 });
    expect(tipOutcomeOf(clean)).toBe('keep_it_up');
    expect(pickTopTip(toScoredTrip(clean, []), [], 'new')).toBeNull();
    // The card the screen shows instead asserts the trip really was clean.
    expect(keepItUpTip.category).toBe('general');
  });

  test('an unscored trip yields no tip, and nothing to coach', () => {
    const passenger = summary({ status: 'unscored', score: null, role: 'passenger' });
    expect(tipOutcomeOf(passenger)).toBe('facts_only');
    expect(unscoredReasonOf(passenger)).toBe('passenger');
    expect(pickTopTip(toScoredTrip(passenger, []), [], 'new')).toBeNull();
  });
})
