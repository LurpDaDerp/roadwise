// "How points work" for DashPal: the x1.25 and its rule, the two penalty rows with their per-drive
// limits, what DashPal events never touch, and the separate report quota. Numbers from @scoring.
import { PENALTIES, RULES } from '@/content/howPoints';

const section = (id: string) => RULES.find((r) => r.id === id)!.points;

test('the DashPal penalty rows carry their per-drive limits', () => {
  expect(PENALTIES.slice(-2)).toEqual([
    { event: 'Eyes off road (DashPal)', penalty: '−40, at most once every 5 min' },
    { event: 'Drowsy (DashPal)', penalty: '−50, at most once every 10 min' },
  ]);
});

test('the multipliers name the DashPal x1.25 and the x1.50 cap', () => {
  expect(section('multipliers')).toContain('A DashPal drive earns ×1.25 on top of that. Together they top out at ×1.50.');
});

test('the DashPal section: what makes a DashPal drive, the events, and what they never touch', () => {
  expect(section('dashpal')).toEqual([
    'A drive is a DashPal drive when your DashPal watched you for at least 80% of the time you were moving (at least 1 min) and your phone had caught up with it by the end of the drive.',
    'DashPal can flag eyes off the road with no look back (−40, at most once every 5 min) and drowsiness (−50, at most once every 10 min).',
    'They count only at 10 mph or more with a good GPS fix, and never in a drive’s first 30 s.',
    'DashPal events never lower your Safety Rating or break a clean drive. They do cost points, like any event.',
  ]);
  expect(section('points').some((p) => p.includes('DashPal events don’t count against it'))).toBe(true);
});

test('"DashPal got it wrong" has its own weekly quota', () => {
  expect(section('mistakes')).toContain('"DashPal got it wrong" is accepted right away too, up to 3 times a week, on top of those.');
});
