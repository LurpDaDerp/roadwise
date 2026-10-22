import {
  AXIS_WEIGHT,
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  DISPUTE_AUTO_PER_WEEK,
  IDLE_END_S,
  MERGE_GAP_S,
  MIN_SCORED_MILES,
  MIN_SCORED_S,
  NOT_DRIVING_PER_MONTH,
  PHONE_PICKUP_MIN_MPH,
  PHONE_PICKUP_WEIGHT_S,
  PHONE_PUTDOWN_QUIET_S,
  RANKED_MIN_MILES,
  RATING_WINDOW_DAYS,
  SPEEDING_GRACE_S,
} from '@scoring';

import { HERO, howItWorks, rules, type DriveNumbers } from '@/content/howScores';

const N: DriveNumbers = { autoTriggerMph: 20, autoTriggerS: 10, waitMin: 5, notDrivingMin: 2 };
const all = (auto: boolean) => [HERO.title, HERO.body, ...howItWorks(auto).flatMap((i) => [i.title, i.body]), ...rules(auto, N).flatMap((s) => [s.title, ...s.lines])];
const section = (auto: boolean, id: string) => rules(auto, N).find((s) => s.id === id)!.lines;

test('no points, streaks, freezes, levels or leagues anywhere; no em dash or exclamation mark', () => {
  for (const auto of [true, false]) {
    for (const line of all(auto)) {
      expect(line).not.toMatch(/\bpoints?\b|\bpts\b|streak|freeze|\blevel\b|league|leaderboard/i);
      expect(line).not.toMatch(/[—!]/);
    }
  }
});

test('the three ideas follow how drives start on this phone', () => {
  expect(howItWorks(true).map((i) => i.title)).toEqual(['Drives record themselves', 'Every drive gets a score', 'Grow your Safety Rating']);
  expect(howItWorks(false)[0]).toMatchObject({ title: 'Start, then drive', body: 'Swipe Start drive before you pull out. RoadWise records until you park.' });
  expect(howItWorks(true)[2]!.body).toBe(`It sums up your last ${RATING_WINDOW_DAYS} days. See how it compares on the Friends tab.`);
  expect(HERO).toEqual({ title: 'Smooth and steady wins', body: 'Every drive gets a score out of 100. Your Safety Rating sums up your last 90 days.' });
});

test('the sections, in order', () => {
  expect(rules(true, N).map((s) => s.id)).toEqual(['drive-score', 'speeding', 'phone', 'rating', 'drives', 'dashpal', 'goals', 'friends', 'mistakes']);
  expect(rules(true, N).find((s) => s.id === 'drives')!.title).toBe('How drives start and end');
  expect(rules(false, N).find((s) => s.id === 'drives')!.title).toBe('Starting a drive');
});

test('every number comes from the rules: the trigger, the wait, the budget, the end and the merge', () => {
  expect(section(true, 'drives')).toEqual([
    `Once you’ve been moving at about 20 mph for 10 s, RoadWise starts recording, counting from the moment you set off.`,
    `It ends once you park and walk away, or after ${IDLE_END_S / 60} min parked.`,
    `Stop for under ${MERGE_GAP_S / 60} min and set off again from the same spot, and it stays one drive.`,
    'Riding along? Open the drive screen and tap “Not driving?”. It shows once the car reaches driving speed, for your first 2 minutes on that screen.',
    'Want to get set before you leave? Swipe Start drive on Home. RoadWise waits up to 5 min for you to get moving.',
  ]);
  const other = rules(true, { autoTriggerMph: 20, autoTriggerS: 45, waitMin: 7, notDrivingMin: 3 });
  expect(other.find((s) => s.id === 'drives')!.lines.join(' ')).toMatch(/about 20 mph for 45 s.*first 3 minutes.*up to 7 min/);
  expect(section(false, 'drives')[0]).toBe('Swipe Start drive on Home before you pull out. RoadWise waits up to 5 min for you to get moving.');
  expect(section(false, 'drives')[2]).toBe('Riding along? Tap “Not driving?” on the drive screen. It shows once the car reaches driving speed, for your first 2 minutes on that screen.');
  // Too short: a Start-card drive is not saved at all, an automatic one gets no score.
  expect(section(true, 'drive-score')[3]).toBe(
    `A drive under ${MIN_SCORED_MILES} mi with under ${MIN_SCORED_S / 60} min of driving gets no score. If you started it with Start drive, it isn’t saved at all.`
  );
  expect(section(false, 'drive-score')[3]).toBe(`A drive under ${MIN_SCORED_MILES} mi with under ${MIN_SCORED_S / 60} min of driving isn’t saved at all.`);
  expect(section(true, 'speeding')[1]).toBe(`You hear a chime when you cross that line. Ease off within ${SPEEDING_GRACE_S} s and it doesn’t count.`);
  expect(section(true, 'rating')).toContain(`You get a rating once you’ve driven ${RANKED_MIN_MILES} mi in the last ${RATING_WINDOW_DAYS} days.`);
  expect(section(true, 'mistakes').join(' ')).toContain(`up to ${DISPUTE_AUTO_PER_WEEK} times a week`);
  expect(section(true, 'mistakes').join(' ')).toContain(`up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of those`);
  expect(section(true, 'mistakes').join(' ')).toContain(`${NOT_DRIVING_PER_MONTH} times a month, within a day of the drive`);
});

test('Phone use: felt from motion alone, never the screen; every number from the scoring rules; the same for both kinds of drive', () => {
  expect(section(true, 'phone')).toEqual([
    'RoadWise feels for your phone being picked up while you drive, from its motion alone. It never sees your screen, your apps or your messages.',
    `A pickup counts once the car is going ${PHONE_PICKUP_MIN_MPH} mph or more. Pick it up at a red light and put it down before you pull away, and it doesn’t count.`,
    `Every second it stays in your hand while you’re moving adds to it. Put it down and pick it up again within ${PHONE_PUTDOWN_QUIET_S} s and it’s still one pickup.`,
    `Each pickup weighs ${PHONE_PICKUP_WEIGHT_S} s plus its time in hand, judged against your time at driving speed, so a long drive isn’t marked down for being long.`,
    'With the drive screen open, you hear a tone and see “Phone down”. With RoadWise in the background, you get a quiet notification instead.',
  ]);
  expect(section(false, 'phone')).toEqual(section(true, 'phone'));
  expect(rules(true, N).find((s) => s.id === 'phone')).toMatchObject({ title: 'Phone use', icon: 'phone-portrait-outline' });
  // The categories that count double come from the weights.
  expect(AXIS_WEIGHT.phone).toBe(2);
  expect(section(true, 'rating')).toContain(
    'It’s the average of your braking, starts, turns, speed, phone use and, with DashPal, attention scores. Phone use and speed count double.'
  );
  expect(section(true, 'drive-score')[0]).toMatch(/speed and phone use/);
  expect(howItWorks(true)[1]!.body).toBe('Gentle stops, smooth starts, easy turns, staying near the limit and leaving your phone alone all help.');
  expect(section(true, 'mistakes').join(' ')).toContain('“phone was mounted”');
});

test('friends see the rating by default; the rest is private until shared', () => {
  expect(section(true, 'friends')).toEqual([
    'The Friends tab ranks you and your friends by Safety Rating.',
    'Friends see your Safety Rating. Your category scores, badges, driving stats and heat map stay private until you share them in Settings › Privacy.',
  ]);
});

test('the three badges, and goals that change no score', () => {
  expect(section(true, 'goals')[1]).toBe('Badges mark milestones: First Drive, Clean 100 and Perfect Week.');
  expect(section(true, 'goals')[0]).toMatch(/never change your scores/);
});
