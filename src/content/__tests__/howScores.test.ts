import {
  AXIS_WEIGHT,
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  DISPUTE_AUTO_PER_WEEK,
  IDLE_END_S,
  MIN_SCORED_MILES,
  MIN_SCORED_S,
  NOT_DRIVING_PER_MONTH,
  PHONE_PICKUP_MIN_MPH,
  PHONE_PICKUP_WEIGHT_S,
  PHONE_PUTDOWN_QUIET_S,
  RANKED_MIN_MILES,
  RATING_WINDOW_DAYS,
} from '@scoring';
import { SPEED_FACTOR_PCT } from '@/core/road';

import { HERO, howItWorks, rules, type DriveNumbers } from '@/content/howScores';

const N: DriveNumbers = { autoMinMph: 15, autoMaxHoldS: 25, autoStepS: 5, autoStepMph: 3, autoInstantMph: 30, waitMin: 5, notDrivingMin: 2 };
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
  expect(howItWorks(true)[2]!.body).toBe(`It sums up your last ${RATING_WINDOW_DAYS} days. Go to the Friends tab to see how it compares.`);
  expect(HERO).toEqual({ title: 'Smooth and steady wins', body: 'Every drive gets a score out of 100. Your Safety Rating sums up your last 90 days.' });
});

test('the sections, in order', () => {
  expect(rules(true, N).map((s) => s.id)).toEqual(['drive-score', 'speeding', 'phone', 'rating', 'drives', 'dashpal', 'goals', 'friends', 'mistakes']);
  expect(rules(true, N).find((s) => s.id === 'drives')!.title).toBe('How drives start and end');
  expect(rules(false, N).find((s) => s.id === 'drives')!.title).toBe('Starting a drive');
});

test('every number comes from the rules: the trigger, the wait, the budget and the end', () => {
  expect(section(true, 'drives')).toEqual([
    'Once you’re over 15 mph, RoadWise starts recording after about 25 s, 5 s sooner for every 3 mph faster, and right away from 30 mph. Short stops in traffic don’t reset it, and the drive counts from the moment you set off.',
    `The drive ends when you park and walk away, or after ${IDLE_END_S / 60} min parked.`,
    'Riding along? Open RoadWise and select “Not driving?” on the drive screen. It appears once the car reaches driving speed and stays for your first 2 minutes on that screen.',
    'Want to get set before you leave? Swipe Start drive on Home. RoadWise waits up to 5 min for you to get moving.',
  ]);
  const other = rules(true, { autoMinMph: 12, autoMaxHoldS: 40, autoStepS: 4, autoStepMph: 2, autoInstantMph: 32, waitMin: 7, notDrivingMin: 3 });
  expect(other.find((s) => s.id === 'drives')!.lines.join(' ')).toMatch(/over 12 mph, .*about 40 s, 4 s sooner for every 2 mph faster, and right away from 32 mph.*first 3 minutes.*up to 7 min/);
  expect(section(false, 'drives')[0]).toBe('Swipe Start drive on Home before you pull out. RoadWise waits up to 5 min for you to get moving.');
  expect(section(false, 'drives')[2]).toBe('Riding along? Select “Not driving?” on the drive screen. It appears once the car reaches driving speed and stays for your first 2 minutes on that screen.');
  // Too short: a Start-card drive is not saved at all, an automatic one gets no score.
  expect(section(true, 'drive-score')[4]).toBe(
    `A drive under ${MIN_SCORED_MILES} mi with under ${MIN_SCORED_S / 60} min of driving gets no score. If you started it with Start drive, RoadWise doesn’t save it at all.`
  );
  expect(section(false, 'drive-score')[4]).toBe(`RoadWise doesn’t save a drive under ${MIN_SCORED_MILES} mi with under ${MIN_SCORED_S / 60} min of driving.`);
  // The speeding line, 1.16 L − 0.8 mph, to the nearest mph; no zones.
  expect(section(true, 'speeding')[0]).toBe(
    'Speeding starts a little over the posted limit, and a little further over on faster roads: about 3 mph over at 25 mph, 5 at 35, 6 at 45, 8 at 55, and 10 at 65.'
  );
  expect(all(true).join(' ')).not.toMatch(/school|construction|zone/);
  expect(section(true, 'speeding')[1]).toBe(
    'You hear a chime and see “Slow down” when you cross that line. Every second over it counts, and it counts more the further over you are. The same amount over counts more on a slow street than on a highway.'
  );
  // How far over is judged against the road's limit (the speed weight's reference is the limit / 7).
  expect(section(true, 'drive-score')[2]).toBe('Speed counts how much of your driving time with a known limit you spent over it, and how far over you went for that road.');
  // Every event counts, weighed by how serious it was and against the whole drive.
  expect(section(true, 'drive-score')[3]).toBe(
    'Every event counts, and a more serious one counts more. That includes a harder brake, start, or turn, a longer or faster stretch over the limit, and a pickup that’s longer or at a higher speed. RoadWise weighs most events against the whole drive, so one hard brake lowers a long drive’s score less than a short one’s. A pickup costs the same however long the drive is.'
  );
  expect(all(true).join(' ')).not.toMatch(/Ease off within/);
  // Attention is judged per second DashPal watched, not per mile.
  expect(section(true, 'dashpal')[0]).toBe('With a DashPal, eyes off the road and drowsiness count toward Attention, but only for the time it watched.');
  expect(all(true).join(' ')).not.toMatch(/miles it watched/);
  expect(section(true, 'dashpal')[1]).toBe('They count only at 10 mph or more with good GPS. Each one counts more the faster you were going and the longer it lasted.');
  expect(section(true, 'rating')).toContain(`You get a rating once you’ve driven ${RANKED_MIN_MILES} mi in the last ${RATING_WINDOW_DAYS} days.`);
  expect(section(true, 'mistakes').join(' ')).toContain(`up to ${DISPUTE_AUTO_PER_WEEK} times a week`);
  expect(section(true, 'mistakes').join(' ')).toContain(`up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of those`);
  expect(section(true, 'mistakes').join(' ')).toContain(`${NOT_DRIVING_PER_MONTH} times a month, within a day of the drive`);
});

test('Phone use: felt from how the phone moves, never what is on the screen; every number from the scoring rules; the same for both kinds of drive', () => {
  expect(section(true, 'phone')).toEqual([
    'RoadWise notices when you pick up your phone while driving, from how your phone moves. It never sees what’s on your screen, your apps, or your messages.',
    `A pickup counts once the car is going ${PHONE_PICKUP_MIN_MPH} mph or more. If you pick it up at a red light and put it down before you pull away, it doesn’t count.`,
    `Every second it stays in your hand while you’re moving adds to it. If you put it down and pick it up again within ${PHONE_PUTDOWN_QUIET_S} s, it’s still one pickup.`,
    `Each pickup weighs ${PHONE_PICKUP_WEIGHT_S} s plus its time in hand, and more the faster you were going (twice as much at 60 mph as at 30). On a drive, each pickup costs the same however long the drive is. Your Safety Rating weighs pickups against your time at driving speed, so it stays fair however much you drive.`,
    'With the drive screen open, you hear a tone and see “Phone down”. With RoadWise in the background, you don’t hear a sound, but the pickup is still recorded and counts.',
  ]);
  expect(section(false, 'phone')).toEqual(section(true, 'phone'));
  expect(rules(true, N).find((s) => s.id === 'phone')).toMatchObject({ title: 'Phone use', icon: 'phone-portrait-outline' });
  // The weights come from AXIS_WEIGHT, heaviest first, against the categories that weigh one; the total is a
  // weighted harmonic mean, so a low score pulls it down more than a high one lifts it.
  expect(AXIS_WEIGHT).toEqual({ speed: 3, phone: 3, attention: 3, braking: 2, acceleration: 1, turning: 1 });
  expect(section(true, 'rating')).toContain(
    'It combines your braking, starts, turns, speed, and phone use scores, plus attention with DashPal. Speed, phone use, and attention count three times as much as starts and turns, and braking counts twice as much. A low score pulls your rating down more than a high score lifts it.'
  );
  expect(section(true, 'rating').join(' ')).not.toMatch(/average|double|triple/);
  expect(section(true, 'drive-score')[0]).toMatch(/speed, and phone use/);
  expect(howItWorks(true)[1]!.body).toBe('Gentle stops, smooth starts, easy turns, staying near the limit, and leaving your phone alone all help.');
  expect(section(true, 'mistakes').join(' ')).toContain('“phone was mounted”');
});

test('the sooner warnings in rain, snow, ice and fog, every number from the warning rules, the same for both kinds of drive', () => {
  const line = section(true, 'drive-score').at(-1)!;
  expect(line).toBe(
    'In rain, snow, ice, or fog, RoadWise warns you sooner, because the car needs more room to stop. “Slow down” comes as if the limit were 90% of the posted one on a wet road, 85% in heavy rain, 80% on snow, and 70% on ice. In fog, it comes at 65 mph down to 35 mph, lower the less you can see. Hard brake, start, and turn warnings come at a lighter touch on a wet road, and lighter still on snow or ice. These warnings show the weather’s icon and color, and they never change your score. The weather comes from a forecast model for where you are.'
  );
  expect(section(false, 'drive-score').at(-1)).toBe(line);
  expect(line).toContain(`${SPEED_FACTOR_PCT.wet}% of the posted one`);
});

test('friends see the rating by default; the rest is private until shared', () => {
  expect(section(true, 'friends')).toEqual([
    'The Friends tab ranks you and your friends by Safety Rating.',
    'Friends see your Safety Rating. Your category scores, badges, driving stats, and heat map stay private until you share them in Settings › Privacy.',
  ]);
});

test('the three badges, and goals that change no score', () => {
  expect(section(true, 'goals')[1]).toBe('Badges mark milestones like First Drive, Clean 100, Clean 1,000, and Rain or Shine.');
  expect(section(true, 'goals')[0]).toMatch(/never change your scores/);
});
