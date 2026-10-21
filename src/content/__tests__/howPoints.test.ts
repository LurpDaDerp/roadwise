// "How points work" for DashPal: the x1.25 and its rule, the two penalty rows with their per-drive
// limits, what DashPal events never touch, and the separate report quota. Numbers from @scoring.
import { HOW_IT_WORKS, PENALTIES, RULES } from '@/content/howPoints';

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
    'DashPal events never break a clean drive. They cost points like any event, and they count toward Attention in your Safety Rating.',
  ]);
  expect(section('points').some((p) => p.includes('DashPal events don’t count against it'))).toBe(true);
});

test('"DashPal got it wrong" has its own weekly quota', () => {
  expect(section('mistakes')).toContain('"DashPal got it wrong" is accepted right away too, up to 3 times a week, on top of those.');
});

test('phone use: leaving RoadWise is phone use too, the navigation button never costs points, and what never counts', () => {
  const phone = section('phone');
  expect(RULES.map((r) => r.id).indexOf('phone')).toBe(1);
  expect(phone).toHaveLength(6);
  expect(phone[1]).toMatch(/^Leaving RoadWise mid-drive counts as phone use too: another app, the home screen, and on Android the app switcher or split screen\. /);
  expect(phone[2]).toBe('The navigation button on the drive screen opens your navigation app and never costs points. If you lock your phone or come back to RoadWise, use the button again to reopen it. Going back any other way costs points.');
  expect(phone[3]).toMatch(/^Locking your phone and the notification shade never count\./);
  expect(phone[3]).toMatch(/Nor does a call’s own screen, but once you’re back in RoadWise for 10 s of the call, leaving again counts\.$/);
  expect(phone[4]).toMatch(/^On iPhone a switch counts once you come back to RoadWise after 15 s or more, or once you’ve been away about 26 s\. One that began with an unlock outside RoadWise, or that a call cut short, needs about 26 s\. A message lighting up the lock screen, or a quick lock and unlock, never counts\. Switches count only once/);
  expect(phone[4]).toMatch(/Several short switches in a row count as one pickup \(on iPhone, ones over about 11 s\)\.$/);
  expect(phone[5]).toBe('Phone use costs more the faster you were going: ×1.5 over 25 mph and ×2 over 45 mph. A pickup while stopped in traffic stays −16.');
  expect(PENALTIES.find((p) => p.event === 'Phone pickup or leaving RoadWise')?.penalty).toBe('−32 (−16 when stopped in traffic), ×1.5 over 25 mph and ×2 over 45 mph');
  expect(PENALTIES.find((p) => p.event === 'Phone handling or time away')?.penalty).toBe('−8 for every extra 15 s, ×1.5 over 25 mph and ×2 over 45 mph');
});

test('earning: 20 a safe mile, +50 clean, the too-short rule, and the +200 challenge', () => {
  expect(HOW_IT_WORKS[0]?.body).toBe('20 points for every safe mile you drive.');
  const points = section('points');
  expect(points[0]).toBe("You get 20 points for every safe mile: miles you weren't speeding or using your phone.");
  expect(points[1]).toBe('Finish a drive of 2 mi or more with zero events for a +50 clean-drive bonus. DashPal events don’t count against it.');
  expect(points[5]).toBe("A drive under 0.5 mi that takes under 2 min isn't scored.");
  expect(section('boards')).toContain('Weekly challenges (3 a week) are worth +200 points each.');
});

test('speeding: the points line per limit, the 5 s grace, and the growing cost with its worked examples', () => {
  expect(RULES.map((r) => r.id).indexOf('speeding')).toBe(2);
  expect(section('speeding')).toEqual([
    'Speeding starts a few mph over the posted limit: 3 over at 25 mph, 4 at 35, 5 at 45, 7 at 55 and 9 at 65 (2 in a school or construction zone).',
    'You hear a chime the moment you cross that line. The first 5 s are free: slow down and it costs nothing.',
    'After that it costs more the further over you are and the longer you stay: 10 s at 3 mph over is about −5, a minute at 3 over about −51. One stretch tops out at −300, before the repeat multiplier for a second or third speeding in the same drive.',
  ]);
  expect(PENALTIES[0]).toEqual({
    event: 'Speeding',
    penalty: '−1 to −300, growing the further over the line you are and the longer you stay, after 5 s of grace',
  });
});

test('the Safety Rating is a weighted average of the categories, with the curve’s worked examples', () => {
  expect(section('rating')).toEqual([
    'Your Safety Rating is a score from 0 to 100 for how safely you drove over the last 30 days.',
    'It’s the average of the categories on your Analytics radar: speed, braking, acceleration, turning and phone use, plus Attention if you drive with DashPal. Speed and phone use count double.',
    'Each category scores how often its events happen per mile (Attention per mile DashPal watched). Streaks, multipliers and the time of day don’t affect it.',
    'One phone pickup every 10 mi scores phone use 80. One hard brake every 20 mi scores braking about 97.',
    'You need 10 mi in the last 30 days to get a rating on the boards.',
  ]);
});

test('no UI string carries an em dash', () => {
  const all = [...HOW_IT_WORKS.map((h) => `${h.title} ${h.body}`), ...PENALTIES.map((p) => `${p.event} ${p.penalty}`), ...RULES.flatMap((r) => [r.title, ...r.points])];
  for (const s of all) expect(s).not.toMatch(/—/);
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
