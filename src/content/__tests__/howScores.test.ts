import {
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  DISPUTE_AUTO_PER_WEEK,
  IDLE_END_S,
  MERGE_GAP_S,
  NOT_DRIVING_PER_MONTH,
  RANKED_MIN_MILES,
  RATING_WINDOW_DAYS,
  SPEEDING_GRACE_S,
} from '@scoring';

import { HERO, howItWorks, rules, type DriveNumbers } from '@/content/howScores';

const N: DriveNumbers = { autoTriggerMph: 15, autoTriggerS: 30, waitMin: 5, notDrivingMin: 2 };
const all = (auto: boolean) => [HERO.title, HERO.body, ...howItWorks(auto).flatMap((i) => [i.title, i.body]), ...rules(auto, N).flatMap((s) => [s.title, ...s.lines])];
const section = (auto: boolean, id: string) => rules(auto, N).find((s) => s.id === id)!.lines;

test('no points, streaks, freezes, levels, leagues or phone use anywhere; no em dash or exclamation mark', () => {
  for (const auto of [true, false]) {
    for (const line of all(auto)) {
      expect(line).not.toMatch(/\bpoints?\b|\bpts\b|streak|freeze|\blevel\b|league|leaderboard|phone use|pickup/i);
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
  expect(rules(true, N).map((s) => s.id)).toEqual(['drive-score', 'speeding', 'rating', 'drives', 'dashpal', 'goals', 'friends', 'mistakes']);
  expect(rules(true, N).find((s) => s.id === 'drives')!.title).toBe('How drives start and end');
  expect(rules(false, N).find((s) => s.id === 'drives')!.title).toBe('Starting a drive');
});

test('every number comes from the rules: the trigger, the wait, the budget, the end and the merge', () => {
  expect(section(true, 'drives')).toEqual([
    `Once you’ve been moving at about 15 mph for 30 s, RoadWise starts recording, counting from the moment you set off.`,
    `It ends once you park and walk away, or after ${IDLE_END_S / 60} min parked.`,
    `Stop for under ${MERGE_GAP_S / 60} min and set off again from the same spot, and it stays one drive.`,
    'Riding along? Open the drive screen and tap “Not driving?”. It’s there for your first 2 minutes on that screen.',
    'Want to get set before you leave? Swipe Start drive on Home. RoadWise waits up to 5 min for you to get moving.',
  ]);
  const other = rules(true, { autoTriggerMph: 20, autoTriggerS: 45, waitMin: 7, notDrivingMin: 3 });
  expect(other.find((s) => s.id === 'drives')!.lines.join(' ')).toMatch(/about 20 mph for 45 s.*first 3 minutes.*up to 7 min/);
  expect(section(false, 'drives')[0]).toBe('Swipe Start drive on Home before you pull out. RoadWise waits up to 5 min for you to get moving.');
  expect(section(true, 'speeding')[1]).toBe(`You hear a chime when you cross that line. Ease off within ${SPEEDING_GRACE_S} s and it doesn’t count.`);
  expect(section(true, 'rating')).toContain(`You get a rating once you’ve driven ${RANKED_MIN_MILES} mi in the last ${RATING_WINDOW_DAYS} days.`);
  expect(section(true, 'mistakes').join(' ')).toContain(`up to ${DISPUTE_AUTO_PER_WEEK} times a week`);
  expect(section(true, 'mistakes').join(' ')).toContain(`up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of those`);
  expect(section(true, 'mistakes').join(' ')).toContain(`${NOT_DRIVING_PER_MONTH} times a month, within a day of the drive`);
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
