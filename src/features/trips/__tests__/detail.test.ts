/** @jest-environment node */
import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { toTripEventView, toTripSummary, type TripEventView } from '@/data/queries';
import {
  canReport,
  confidenceLevel,
  confidenceReasons,
  eventStanding,
  groupTripsByDay,
  historyItems,
  measuredLine,
  regionFor,
  routeFor,
  routeSegments,
  severityWord,
  standingLabel,
  standingWhy,
  timelineRows,
  TRIM_ENDPOINTS_M,
  trimRoute,
  whyItMatters,
} from '@/features/trips/detail';
import type { LatLng } from '@/lib/geo';
import { encodePolyline } from '@/lib/polyline';

const view = (over: Parameters<typeof eventRow>[0] = {}): TripEventView =>
  toTripEventView(eventRow(over));

const trip = (over: Parameters<typeof tripRow>[0] = {}) => toTripSummary(tripRow(over));

describe('what was measured, in the driver s units', () => {
  test('speeding reads as a speed in a zone for a time', () => {
    expect(
      measuredLine(
        view({ measured_json: JSON.stringify({ speedMps: 21, limitMps: 15.6 }), duration_s: 38 })
      )
    ).toBe('47 mph in a 35 zone for 38 s');
  });

  test('a stretch with no posted limit says the speed and the time, and invents no zone', () => {
    const line = measuredLine(
      view({ measured_json: JSON.stringify({ speedMps: 21 }), duration_s: 38 })
    );
    expect(line).toBe('47 mph for 38 s');
    expect(line).not.toContain('zone');
  });

  test('each category reads as what it actually measured', () => {
    expect(
      measuredLine(view({ category: 'phone', duration_s: 12, measured_json: JSON.stringify({ speedMps: 15 }) }))
    ).toBe('Phone handled for 12 s at 34 mph');
    expect(
      measuredLine(view({ category: 'braking', measured_json: JSON.stringify({ peakG: 0.45 }) }))
    ).toBe('Braked at 0.45 g');
    expect(
      measuredLine(view({ category: 'accel', measured_json: JSON.stringify({ peakG: 0.4 }) }))
    ).toBe('Pulled away at 0.40 g');
    expect(
      measuredLine(view({ category: 'cornering', measured_json: JSON.stringify({ lateralG: 0.5 }) }))
    ).toBe('Turned at 0.50 g');
    expect(
      measuredLine(
        view({ category: 'focus', measured_json: JSON.stringify({ focusKind: 'glance', glanceS: 3.2 }) })
      )
    ).toBe('Eyes off the road for 3 s');
    expect(
      measuredLine(
        view({ category: 'focus', measured_json: JSON.stringify({ focusKind: 'drowsiness' }) })
      )
    ).toBe('Signs of drowsiness');
  });

  test('a measurement the row does not hold degrades to the short line, never to NaN', () => {
    const line = measuredLine(view({ category: 'braking', measured_json: null }));
    expect(line).toBe('Hard brake');
    expect(line).not.toMatch(/NaN|undefined/);
  });
});

describe('how hard, and how sure', () => {
  test('severity is the category s own top band, not a scale invented here', () => {
    // Speeding enters its top bands at s = 3.5.
    expect(severityWord(view({ severity: '3.5' }))).toBe('severe');
    expect(severityWord(view({ severity: '2' }))).toBe('moderate');
    expect(severityWord(view({ severity: '0' }))).toBe('none');
    // Braking's top band starts lower, and the same number means something different there.
    expect(severityWord(view({ category: 'braking', severity: '2' }))).toBe('severe');
  });

  test('confidence is the scorer s own three bands', () => {
    expect(confidenceLevel(view({ confidence: 0.9 }))).toBe('high');
    expect(confidenceLevel(view({ confidence: 0.6 }))).toBe('medium');
    expect(confidenceLevel(view({ confidence: 0.2 }))).toBe('low');
    expect(confidenceLevel(view({ confidence: null }))).toBe('low');
  });

  test('the reason names the sensors the event came from, and says when no limit was known', () => {
    expect(confidenceReasons(view())).toEqual(['Speed from GPS', 'speed limit from map data']);
    expect(confidenceReasons(view({ measured_json: JSON.stringify({ speedMps: 21 }) }))).toEqual([
      'Speed from GPS',
      'no speed limit was known here',
    ]);
    expect(confidenceReasons(view({ category: 'braking' }))).toEqual([
      "From your phone's motion sensors",
    ]);
    expect(confidenceReasons(view({ category: 'focus' }))).toEqual([
      'From the camera, processed on your phone',
    ]);
  });

  test('easing off after the alert is part of why the app is as sure as it is', () => {
    expect(confidenceReasons(view({ corrected: 1 }))).toContain('you eased off right after the alert');
  });

  test('every category has one sentence on why it matters', () => {
    for (const category of ['phone', 'speeding', 'braking', 'accel', 'cornering', 'focus'] as const) {
      expect(whyItMatters(category)).toEqual(expect.any(String));
    }
    expect(whyItMatters(null)).toBeNull();
  });
});

describe('where an event stands against the score', () => {
  test('a scored event that cost points is counted', () => {
    expect(eventStanding(view())).toBe('counted');
  });

  test('a low-confidence event is detected, not counted, and not offered a report', () => {
    // It costs nothing, so there is nothing to take off — and the server refuses every such
    // report with `event_not_scored`, which is a dead end to steer a driver into.
    const possible = view({ status: 'possible', deduction: 0 });
    expect(eventStanding(possible)).toBe('possible');
    expect(canReport(possible)).toBe(false);
  });

  test('a report still travelling keeps costing what it cost', () => {
    const sending = view({
      status: 'disputed',
      deduction: 6,
      dispute_json: JSON.stringify({ reason: 'hazard', outcome: 'queued' }),
    });
    expect(sending.affectsScore).toBe(true);
    const drive = trip({ category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) });
    expect(timelineRows(drive, [sending])[0]?.points).toBe(6);
  });

  test('a report that has not been sent yet says so, and is not offered twice', () => {
    const sending = view({
      status: 'disputed',
      dispute_json: JSON.stringify({ reason: 'hazard', outcome: 'queued' }),
    });
    expect(eventStanding(sending)).toBe('reportSending');
    expect(canReport(sending)).toBe(false);
  });

  test('the server s answers each have their own standing', () => {
    const record = (outcome: string, code: string | null = null) =>
      JSON.stringify({ reason: 'hazard', outcome, code });
    expect(eventStanding(view({ status: 'removed', dispute_json: record('accepted') }))).toBe(
      'reportAccepted'
    );
    expect(eventStanding(view({ dispute_json: record('denied') }))).toBe('reportRecorded');
    expect(
      eventStanding(view({ dispute_json: record('window_closed', 'dispute_window_closed') }))
    ).toBe('reportClosed');
  });

  test('a refusal that is not about the window is never reported as the window closing', () => {
    const refused = (code: string) =>
      view({ dispute_json: JSON.stringify({ reason: 'hazard', outcome: 'refused', code }) });
    for (const code of ['event_not_scored', 'trip_not_scored', 'not_found', 'ambiguous_event']) {
      const event = refused(code);
      expect(eventStanding(event)).toBe('reportRefused');
      expect(standingLabel(eventStanding(event))).not.toContain('too late');
      expect(standingWhy(event)).not.toContain('14 days');
      // Final: the server decided, so the button does not come back.
      expect(canReport(event)).toBe(false);
    }
  });

  test('a report that never left can be sent again, and says so', () => {
    const unsent = view({
      dispute_json: JSON.stringify({
        reason: 'hazard',
        outcome: 'refused',
        code: 'retries_exhausted',
      }),
    });
    expect(eventStanding(unsent)).toBe('reportUnsent');
    expect(standingWhy(unsent)).toBe("We couldn't get it through. You can send it again.");
    expect(canReport(unsent)).toBe(true);
  });

  test('a denied report names the rail the server said it hit', () => {
    const denied = (rail: string | null) =>
      view({
        dispute_json: JSON.stringify({ reason: 'hazard', outcome: 'denied', deniedReason: rail }),
      });
    expect(standingWhy(denied('allowance_7d'))).toContain('three reports for this week');
    expect(standingWhy(denied('allowance_30d'))).toContain('a lot of moments this month');
    // A rail this build does not know falls back to what is true of both.
    expect(standingWhy(denied(null))).toContain('used your reports for now');
  });

  test('an event removed by something other than a report is not credited to the driver', () => {
    expect(eventStanding(view({ status: 'removed', deduction: 0 }))).toBe('removed');
  });
});

describe('the timeline', () => {
  test('is in the order the drive happened, with everything a row prints already decided', () => {
    const events = [
      view({ id: 'e1', started_at: T0 + 60_000 }),
      view({ id: 'e2', started_at: T0 + 120_000, status: 'possible', deduction: 0, severity: '2' }),
    ];
    const drive = trip({ category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) });
    const rows = timelineRows(drive, events);
    expect(rows.map((row) => row.event.id)).toEqual(['e1', 'e2']);
    expect(rows[0]).toMatchObject({ title: 'Speeding', standing: 'counted', points: 6 });
    expect(rows[1]).toMatchObject({ standing: 'possible', points: null });
  });

  test('a speeding row below the action line is marked reading-uncertain; a confident one is not', () => {
    const rows = timelineRows(trip(), [
      view({ id: 'unsure', category: 'speeding', confidence: 0.6 }),
      view({ id: 'sure', category: 'speeding', confidence: 0.9 }),
      view({ id: 'phone', category: 'phone', confidence: 0.6, measured_json: '{}' }),
    ]);
    expect(rows.map((r) => r.readingUncertain)).toEqual([true, false, false]);
  });

  test('a possible event never shows points, even when a deduction was stored on it', () => {
    const rows = timelineRows(trip(), [view({ status: 'possible', deduction: 6 })]);
    expect(rows[0]?.points).toBeNull();
  });

  test('a capped category shows what its moments cost, not what they would have', () => {
    // Two phone events at 32 and 8 pre-cap; the phone cap is 30, so the drive lost 30, not 40.
    const drive = trip({ category_deductions_json: JSON.stringify(deductions({ phone: 30 })) });
    const events = [
      view({ id: 'big', category: 'phone', deduction: 32, measured_json: '{}' }),
      view({ id: 'small', category: 'phone', deduction: 8, measured_json: '{}' }),
    ];

    const rows = timelineRows(drive, events);
    const shown = rows.map((row) => row.points ?? 0);

    // Each moment keeps its share, and the shares add up to what the bar says.
    expect(shown[0]).toBeCloseTo(24, 6);
    expect(shown[1]).toBeCloseTo(6, 6);
    expect(shown.reduce((sum, value) => sum + value, 0)).toBeCloseTo(30, 6);
    // Never the raw figure, which would sit above a bar reading "30 of 30".
    expect(shown[0]).toBeLessThan(32);
  });

  test('an uncapped category is left exactly as the scorer charged it', () => {
    const drive = trip({ category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) });
    expect(timelineRows(drive, [view({ deduction: 6 })])[0]?.points).toBe(6);
  });
});

describe('the route', () => {
  const line = (n: number): LatLng[] =>
    Array.from({ length: n }, (_, i) => ({ lat: 45.5 + i * 0.01, lng: -122.6 }));

  test('both ends are trimmed before anything is drawn', () => {
    const points = line(40);
    const trimmed = trimRoute(points, TRIM_ENDPOINTS_M);
    expect(trimmed.length).toBeLessThan(points.length);
    expect(trimmed[0]).not.toEqual(points[0]);
    expect(trimmed[trimmed.length - 1]).not.toEqual(points[points.length - 1]);
  });

  test('a drive too short to trim is withheld rather than drawn as a fragment', () => {
    expect(trimRoute(line(3), 100_000)).toEqual([]);
  });

  test('a drive with no stored route has nothing to draw', () => {
    expect(routeFor(trip({ polyline: null }))).toEqual([]);
    expect(routeFor(trip({ polyline: '' }))).toEqual([]);
  });

  test('a stored polyline is decoded and trimmed', () => {
    const points = line(40);
    const decoded = routeFor(trip({ polyline: encodePolyline(points) }));
    expect(decoded.length).toBeGreaterThan(1);
    expect(decoded.length).toBeLessThan(points.length);
  });

  test('the stretches a speeding episode was recorded on are their own segments', () => {
    const points = line(10);
    const near = points[5];
    if (!near) throw new Error('fixture');
    const segments = routeSegments(points, [
      view({ category: 'speeding', lat: near.lat, lng: near.lng }),
    ]);
    expect(segments.some((segment) => segment.over)).toBe(true);
    expect(segments.some((segment) => !segment.over)).toBe(true);
    // Every point is still on the line: splitting is not dropping.
    expect(segments.reduce((sum, segment) => sum + segment.points.length - 1, 0)).toBe(
      points.length - 1
    );
  });

  test('an episode that no longer counts does not colour the road', () => {
    const points = line(10);
    const near = points[5];
    if (!near) throw new Error('fixture');
    const removed = view({
      category: 'speeding',
      lat: near.lat,
      lng: near.lng,
      status: 'removed',
      deduction: 0,
    });
    expect(routeSegments(points, [removed]).every((segment) => !segment.over)).toBe(true);
  });

  test('the region covers every point with room around it', () => {
    const region = regionFor(line(10));
    expect(region).toMatchObject({ longitude: -122.6 });
    expect(region?.latitudeDelta).toBeGreaterThan(0.09);
    expect(regionFor([])).toBeNull();
  });
});

describe('the history list', () => {
  const at = (day: number, id: string) =>
    trip({ client_trip_id: id, started_at: T0 + day * 86_400_000 });

  test('drives are grouped by the day they were driven, in the order they arrive', () => {
    const groups = groupTripsByDay([at(1, 'c'), at(1, 'b'), at(0, 'a')]);
    expect(groups.map((group) => group.day)).toEqual(['2026-01-06', '2026-01-05']);
    expect(groups[0]?.trips.map((t) => t.clientTripId)).toEqual(['c', 'b']);
  });

  test('the day a drive belongs to is its own local day, not the device s', () => {
    // 01:30 UTC on the 6th is still the 5th in Los Angeles, which is where this drive happened.
    const late = trip({ started_at: Date.UTC(2026, 0, 6, 1, 30), tz: 'America/Los_Angeles' });
    expect(groupTripsByDay([late])[0]?.day).toBe('2026-01-05');
  });

  test('the flat list is a header followed by its drives', () => {
    const items = historyItems(groupTripsByDay([at(1, 'b'), at(0, 'a')]));
    expect(items.map((item) => item.kind)).toEqual(['day', 'trip', 'day', 'trip']);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});
