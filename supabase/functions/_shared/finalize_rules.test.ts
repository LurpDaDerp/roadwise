import { assertEquals } from '@std/assert';
import { distanceM, integrityReason, milesExceedRoute, POLYLINE_SLACK_MILES, polylineMiles } from './finalize_rules.ts';
import { localDayOf, isKnownTz } from './local_day.ts';
import { lineOfMiles, payload } from './testing/v5_fixtures.ts';

Deno.test('integrity: mock location is spoofed; motion mismatch, a 170 mph fix, 150 mph average or bad GNSS is implausible', () => {
  const ok = payload();
  assertEquals(integrityReason(ok), null);
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, mockLocation: true, motionMismatch: true } })), 'spoofed');
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, motionMismatch: true } })), 'implausible');
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, maxSpeedMph: 170 } })), 'implausible');
  assertEquals(integrityReason(payload({ miles: 75 })), 'implausible'); // 75 mi in 30 min
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, validGnssPct: 10 } })), 'implausible');
  assertEquals(integrityReason(payload({ miles: 0.6, integrity: { ...ok.integrity, validGnssPct: 10 } })), null);
});

Deno.test('miles cross-check: miles above polyline × 1.25 + 10 are implausible (both end trims at their widest plus up to six widened 800 m zones crossed edge to edge stay under it); a broken polyline allows 10', () => {
  const eight = lineOfMiles(8);
  assertEquals(Math.abs(polylineMiles(eight) - 8) < 0.02, true);
  assertEquals(POLYLINE_SLACK_MILES, 10);
  assertEquals(milesExceedRoute(20, eight), false);
  assertEquals(milesExceedRoute(20.05, eight), true);
  assertEquals(milesExceedRoute(10, ''), false);
  assertEquals(milesExceedRoute(10.01, ''), true);
  assertEquals(polylineMiles('abc_def'), 0); // decodes to no usable line: treated as empty
  assertEquals(milesExceedRoute(11, 'abc_def'), true);
  assertEquals(integrityReason(payload({ miles: 11, polyline: 'abc_def' })), 'implausible');
  assertEquals(integrityReason(payload({ miles: 24, polyline: eight })), 'implausible');
  assertEquals(integrityReason(payload({ miles: 14, polyline: eight })), null);
  assertEquals(integrityReason(payload({ miles: 3.9, polyline: '' })), null);
});

Deno.test('miles cross-check: a drive through several enlarged privacy zones keeps the miles they hide (14 mi with 4.1 mi showing)', () => {
  // An 800 m zone cut at 1.5x hides up to 2.4 km crossed edge to edge; with six of them and both
  // ends trimmed at their widest, 9.9 of 14 miles can be hidden.
  assertEquals(integrityReason(payload({ miles: 14, polyline: lineOfMiles(4.1) })), null);
  assertEquals(milesExceedRoute(14, lineOfMiles(4.1)), false);
});

Deno.test('miles cross-check: a drive the trims hid whole (no route uploaded) is never refused for its miles', () => {
  // A 40-minute practice session on the streets inside an 800 m Home zone: 7 miles, nothing outside it.
  assertEquals(integrityReason(payload({ miles: 7, polyline: '' })), null);
  assertEquals(integrityReason(payload({ miles: 40, durationS: 3600, polyline: '' })), null);
  // The other rules still apply to it.
  assertEquals(integrityReason(payload({ miles: 75, polyline: '' })), 'implausible'); // 75 mi in 30 min
});

Deno.test('miles cross-check sums every visible run: a 10 mi drive through a mid-route privacy zone (4.5 mi + 4.5 mi) is plausible', () => {
  const twoRuns = `${lineOfMiles(4.5)} ${lineOfMiles(4.5, 40.9, -74.006)}`;
  assertEquals(Math.abs(polylineMiles(twoRuns) - 9) < 0.03, true);
  assertEquals(milesExceedRoute(10, twoRuns), false);
  assertEquals(integrityReason(payload({ miles: 10, polyline: twoRuns })), null);
  // Only the longer half would refuse a 16 mi drive the two runs allow: 16 > 4.5 x 1.25 + 10.
  assertEquals(milesExceedRoute(16, twoRuns), false);
  assertEquals(milesExceedRoute(16, lineOfMiles(4.5)), true);
  // Three runs; a run that does not decode counts nothing, the others still count.
  assertEquals(Math.abs(polylineMiles(`${lineOfMiles(2)} abc_def ${lineOfMiles(3, 41, -74)}`) - 5) < 0.03, true);
  assertEquals(polylineMiles(' '), 0);
});

Deno.test('distanceM is great-circle metres', () => {
  const a = { lat: 40.7128, lng: -74.006 };
  assertEquals(Math.round(distanceM(a, { lat: 40.7128 + 150 / 111_195, lng: -74.006 })), 150);
});

Deno.test('local day follows the zone; unknown zones and offsets are refused', () => {
  const t = Date.UTC(2026, 9, 5, 3, 30); // 03:30 UTC on the 5th
  assertEquals(localDayOf(t, 'America/New_York'), '2026-10-04');
  assertEquals(localDayOf(t, 'Europe/London'), '2026-10-05');
  assertEquals(localDayOf(t, 'Asia/Tokyo'), '2026-10-05');
  assertEquals(localDayOf(t, 'UTC'), '2026-10-05');
  assertEquals([isKnownTz('Mars/Olympus'), isKnownTz('+05:00'), isKnownTz('UTC+5'), isKnownTz('America/Los_Angeles'), isKnownTz('US/Pacific')], [false, false, false, true, true]);
  assertEquals(localDayOf(t, 'Mars/Olympus'), null);
});
