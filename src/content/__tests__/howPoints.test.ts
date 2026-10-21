// "How points work" for DashPal: the x1.25 and its rule, the two penalty rows with their per-drive
// limits, what DashPal events never touch, and the separate report quota. Numbers from @scoring.
import { PENALTIES, RULES } from '@/content/howPoints';

const section = (id: string) => RULES.find((r) => r.id === id)!.points;

test('the DashPal penalty rows carry their per-drive limits', () => {
  expect(PENALTIES.slice(-2)).toEqual([
    { event: 'Eyes off road (DashPal)', penalty: '−32, at most once every 5 min' },
    { event: 'Drowsy (DashPal)', penalty: '−40, at most once every 10 min' },
  ]);
});

test('the multipliers name the DashPal x1.25 and the x1.50 cap', () => {
  expect(section('multipliers')).toContain('A DashPal drive earns ×1.25 on top of that. Together they top out at ×1.50.');
});

test('the DashPal section: what makes a DashPal drive, the events, and what they never touch', () => {
  expect(section('dashpal')).toEqual([
    'A drive is a DashPal drive when DashPal watched you for at least 80% of your time moving (at least 1 min) and your phone caught up with it by the end.',
    'DashPal flags eyes off the road with no look back, or slumping out of view at speed (−32, at most once every 5 min), and drowsiness (−40, at most once every 10 min).',
    'They count only at 10 mph or more with good GPS, and not in the first 30 s of a drive you started while stopped (unless your last drive ended within 5 min).',
    'DashPal may alarm below 10 mph; those alarms cost no points.',
    'DashPal events never lower your Safety Rating or break a clean drive. They do cost points, like any event.',
  ]);
  expect(section('points').some((p) => p.includes('DashPal events don’t count against it'))).toBe(true);
});

test('"DashPal got it wrong" has its own weekly quota', () => {
  expect(section('mistakes')).toContain('"DashPal got it wrong" is accepted right away too, up to 3 times a week, on top of those.');
});

test('phone use: leaving RoadWise is phone use too, the navigation button never costs points, and what never counts', () => {
  const phone = section('phone');
  expect(RULES.map((r) => r.id).indexOf('phone')).toBe(1);
  expect(phone).toHaveLength(5);
  expect(phone[1]).toMatch(/^Leaving RoadWise mid-drive counts as phone use too: another app, the home screen, and on Android the app switcher or split screen\. /);
  expect(phone[2]).toBe('The navigation button on the drive screen opens your navigation app and never costs points. If you lock your phone or come back to RoadWise, use the button again to reopen it. Going back any other way costs points.');
  expect(phone[3]).toMatch(/^Locking your phone and the notification shade never count\./);
  expect(phone[3]).toMatch(/Nor does a call’s own screen, but once you’re back in RoadWise for 10 s of the call, leaving again counts\.$/);
  expect(phone[4]).toMatch(/^On iPhone a switch counts once you come back to RoadWise after 15 s or more, or once you’ve been away about 26 s\. One that began with an unlock outside RoadWise, or that a call cut short, needs about 26 s\. A message lighting up the lock screen, or a quick lock and unlock, never counts\. Switches count only once/);
  expect(phone[4]).toMatch(/Several short switches in a row count as one pickup \(on iPhone, ones over about 11 s\)\.$/);
  expect(PENALTIES.find((p) => p.event === 'Phone pickup or leaving RoadWise')?.penalty).toBe('−32 (−16 when stopped in traffic)');
  expect(PENALTIES.find((p) => p.event === 'Phone handling or time away')?.penalty).toBe('−8 for every extra 15 s');
});

test('the "how it works" card and the onboarding step name leaving RoadWise mid-drive', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the onboarding copy, beside the content it repeats
  const { HOW_IT_WORKS } = require('@/content/howPoints') as typeof import('@/content/howPoints');
  const line = 'Speeding, hard braking and phone use (even leaving RoadWise mid-drive) cost points.';
  expect(HOW_IT_WORKS[1]?.body).toBe(line);
  expect(line.length).toBe(83);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  expect(JSON.stringify(require('@/features/onboarding/copy'))).toContain(line);
});
