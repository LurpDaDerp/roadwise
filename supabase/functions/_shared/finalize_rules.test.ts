import { assertEquals } from '@std/assert';
import { distanceM, integrityReason, isLoopDrive, unscoredBreakdown } from './finalize_rules.ts';
import { localDayOf, isKnownTz } from './local_day.ts';
import { scoreDrive } from './scoring/index';
import { payload } from './testing/v3_fixtures.ts';

Deno.test('integrity: mock location is spoofed; motion mismatch, a 170 mph fix, 150 mph average or bad GNSS is implausible', () => {
  const ok = payload();
  assertEquals(integrityReason(ok), null);
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, mockLocation: true, motionMismatch: true } })), 'spoofed');
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, motionMismatch: true } })), 'implausible');
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, maxSpeedMph: 170 } })), 'implausible');
  assertEquals(integrityReason(payload({ miles: 75, safeMiles: 75 })), 'implausible'); // 75 mi in 30 min
  assertEquals(integrityReason(payload({ integrity: { ...ok.integrity, validGnssPct: 10 } })), 'implausible');
  assertEquals(integrityReason(payload({ miles: 0.6, safeMiles: 0.6, integrity: { ...ok.integrity, validGnssPct: 10 } })), null);
});

Deno.test('loop: 402 m and 5 miles are the bounds; a missing end point is never a loop', () => {
  const a = { lat: 40.7128, lng: -74.006 };
  assertEquals(Math.round(distanceM(a, { lat: 40.7128 + 402 / 111_320, lng: -74.006 })), 402);
  assertEquals(isLoopDrive(a, { lat: 40.7128 + 400 / 111_320, lng: -74.006 }, 4.9), true);
  assertEquals(isLoopDrive(a, { lat: 40.7128 + 410 / 111_320, lng: -74.006 }, 4.9), false);
  assertEquals(isLoopDrive(a, a, 5), false);
  assertEquals(isLoopDrive(a, null, 1), false);
  assertEquals(isLoopDrive(null, a, 1), false);
});

Deno.test('an unscored breakdown keeps the miles and zeroes everything credited or charged', () => {
  const bd = unscoredBreakdown(scoreDrive({ miles: 12, safeMiles: 11.8, events: [], dmsOn: true }, { streak: 10, safeMilesEarlierToday: 0 }));
  assertEquals([bd.scored, bd.safeMiles, bd.creditedMiles, bd.gains, bd.penalties, bd.net, bd.ratingPenalty, bd.events], [false, 11.8, 0, 0, 0, 0, 0, []]);
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
