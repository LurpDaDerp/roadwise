import { BANNED_COPY, renderInboxBase, renderLocal, renderPush } from '../catalog';

const MILE = 1609.344;
const trip = (distanceM: number, roleUnknown = false, count = 1, scorableIfDriver = true) =>
  renderLocal('trip_summary', { clientTripId: 'trip_01-A', distanceM, roleUnknown, scorableIfDriver, count });

/** A local notification must not claim a result: the score is provisional at finalize. */
const CLAIMS_RESULT = /is scored|your score|score of|\d+ ?(points|pts)/i;

describe('renderLocal — the one copy of the drive summary', () => {
  test('one drive', () => {
    expect(trip(3.24 * MILE)).toEqual({
      title: 'Drive summary ready',
      body: 'Your 3.2 mi drive is ready. Tap to see how it went.',
      url: '/trips/trip_01-A/summary',
      channelId: 'trips',
    });
  });

  test('one drive of ten miles or more reads in whole miles', () => {
    expect(trip(25.4 * MILE).body).toBe('Your 25 mi drive is ready. Tap to see how it went.');
  });

  test('one drive with no measurable distance says nothing it cannot back', () => {
    expect(trip(0)).toEqual({
      title: 'Drive summary ready',
      body: 'Your drive is ready. Tap to see how it went.',
      url: '/trips/trip_01-A/summary',
      channelId: 'trips',
    });
  });

  test('role unknown on a drive that would score asks who drove, so it can be scored', () => {
    expect(trip(3.24 * MILE, true)).toEqual({
      title: 'Were you driving?',
      body: 'Tell us who drove your 3.2 mi trip so it can be scored.',
      url: '/trips/trip_01-A/summary',
      categoryId: 'trip_role',
      channelId: 'trips',
    });
    expect(trip(0, true).body).toBe('Tell us who drove this trip so it can be scored.');
  });

  // Ruling T4 I2: `role_unknown` masks grade C and too-short in the scorer, so answering would
  // not produce a score. The notifier re-runs the gate as a driver and passes false for either.
  test.each([
    ['grade C (poor GPS)', 3.24 * MILE, 'Tell us who drove your 3.2 mi trip.'],
    ['too short to score', 0.3 * MILE, 'Tell us who drove your 0.3 mi trip.'],
    ['no measurable distance', 0, 'Tell us who drove this trip.'],
  ])('role unknown on a drive that would not score (%s) promises no score', (_why, d, body) => {
    expect(trip(d, true, 1, false)).toEqual({
      title: 'Were you driving?',
      body,
      url: '/trips/trip_01-A/summary',
      categoryId: 'trip_role',
      channelId: 'trips',
    });
  });

  test('scorability changes only the role question', () => {
    expect(trip(3.24 * MILE, false, 1, false)).toEqual(trip(3.24 * MILE, false, 1, true));
    expect(trip(3.24 * MILE, true, 2, false)).toEqual(trip(3.24 * MILE, true, 2, true));
  });

  test.each([2, 5])('%i drives batch into one', (n) => {
    expect(trip(3.24 * MILE, false, n)).toEqual({
      title: `${n} drives are ready`,
      body: 'Tap to see how they went.',
      url: '/trips',
      channelId: 'trips',
    });
  });

  test('a batch wins over role-unknown: the list is where each is answered', () => {
    expect(trip(MILE, true, 2)).toEqual(trip(MILE, false, 2));
  });
});

describe('renderPush — permission lapsed', () => {
  const lapse = (permission: 'location_always' | 'location' | 'motion') =>
    renderPush('permission_lapsed', { permission, platform: 'android', deviceId: 'dev-1' });

  test('each permission names its own consequence', () => {
    expect(lapse('location_always')).toEqual({
      title: 'Automatic recording is off',
      body: "RoadWise can't start drives on its own right now. Tap to fix it.",
      url: '/permissions',
      channelId: 'recording_problems',
    });
    expect(lapse('location')).toEqual({
      title: 'Drive recording is off',
      body: "Location access is off, so drives can't be recorded. Tap to fix it.",
      url: '/permissions',
      channelId: 'recording_problems',
    });
    expect(lapse('motion')).toEqual({
      title: 'Drive detection needs attention',
      body: 'Motion access is off, so drives are harder to detect. Tap to fix it.',
      url: '/permissions',
      channelId: 'recording_problems',
    });
  });
});

describe('renderPush — the rewards notifications', () => {
  test('a streak milestone', () => {
    expect(renderPush('streak_milestone', { days: 30, reachedOn: '2026-09-21' })).toEqual({
      title: '30-day safe streak',
      body: 'Your safe-day streak just reached 30. Tap to see it.',
      url: '/rewards',
      channelId: 'rewards',
    });
  });

  test('a weekly goal, met on target and prorated', () => {
    const weekly = (prorated: boolean) =>
      renderPush('goal_completed', { kind: 'weekly_goal', category: 'speeding', weekStart: '2026-09-14', points: 150, prorated });
    expect(weekly(false)).toEqual({
      title: 'Weekly goal done',
      body: "You met this week's goal. +150 points.",
      url: '/rewards/goal',
      channelId: 'rewards',
    });
    expect(weekly(true)).toEqual({
      title: 'Weekly goal done',
      body: 'You met your goal on every day you drove this week. +150 points.',
      url: '/rewards/goal',
      channelId: 'rewards',
    });
  });

  test('a challenge', () => {
    expect(renderPush('goal_completed', { kind: 'challenge', challengeId: 'safe_run', points: 300 })).toEqual({
      title: 'Challenge complete',
      body: 'You finished a challenge. +300 points.',
      url: '/rewards/challenges',
      channelId: 'rewards',
    });
  });

  test('a new class', () => {
    expect(renderPush('level_up', { kind: 'level', level: 5, name: 'Road-wise' })).toEqual({
      title: 'New class: Road-wise',
      body: 'Your RoadWise card now shows Road-wise.',
      url: '/rewards',
      channelId: 'rewards',
    });
  });

  test('a new badge names its tier and nothing else', () => {
    expect(renderPush('level_up', { kind: 'badge', badgeId: 'phone_free_days_50', tier: 'silver' })).toEqual({
      title: 'New badge',
      body: 'You earned a silver badge. Tap to see it.',
      url: '/rewards/badges',
      channelId: 'rewards',
    });
  });

  test('a referral, for each side, names neither person', () => {
    expect(renderPush('referral_qualified', { role: 'invitee', points: 500 })).toEqual({
      title: "Your friend's code counts",
      body: 'You finished 3 scored drives. +500 points.',
      url: '/rewards/invite',
      channelId: 'rewards',
    });
    expect(renderPush('referral_qualified', { role: 'referrer', points: 500 })).toEqual({
      title: 'An invite counts',
      body: 'One of your invites counts now. +500 points.',
      url: '/rewards/invite',
      channelId: 'rewards',
    });
  });

  test('the inbox uses the same words and link as the push', () => {
    const payload = { kind: 'badge', badgeId: 'challenges_1', tier: 'bronze' };
    const pushed = renderPush('level_up', payload);
    expect(renderInboxBase('level_up', payload)).toEqual({ title: pushed?.title, body: pushed?.body, url: pushed?.url });
  });
});

describe('renderInboxBase', () => {
  const tripPayload = {
    clientTripId: 'trip_01-A',
    startedAt: '2026-09-22T08:00:00.000Z',
    endedAt: '2026-09-22T08:20:00.000Z',
    distanceM: 3.24 * MILE,
    status: 'provisional' as const,
    roleUnknown: true,
  };

  test('a drive summary uses the words the driver saw on the notification', () => {
    for (const scorableIfDriver of [true, false]) {
      const { title, body, url } = trip(3.24 * MILE, true, 1, scorableIfDriver);
      expect(renderInboxBase('trip_summary', { ...tripPayload, scorableIfDriver })).toEqual({ title, body, url });
    }
  });

  test('a payload that does not say the drive would score makes no scoring promise', () => {
    expect(renderInboxBase('trip_summary', tripPayload)?.body).toBe('Tell us who drove your 3.2 mi trip.');
  });

  test('a permission lapse uses its push copy', () => {
    const payload = { permission: 'motion' as const, platform: 'ios' as const, deviceId: 'd' };
    const pushed = renderPush('permission_lapsed', payload);
    expect(renderInboxBase('permission_lapsed', payload)).toEqual({
      title: pushed?.title,
      body: pushed?.body,
      url: pushed?.url,
    });
  });

  test('a payload that fails its schema renders nothing', () => {
    expect(renderInboxBase('trip_summary', { ...tripPayload, clientTripId: '../x' })).toBeNull();
  });
});

describe('every string', () => {
  const locals = [0, 0.3 * MILE, 3.24 * MILE, 9.96 * MILE, 250 * MILE].flatMap((d) =>
    [1, 2, 5].flatMap((count) =>
      [false, true].flatMap((roleUnknown) => [false, true].map((scorable) => trip(d, roleUnknown, count, scorable)))
    )
  );
  const pushes = (['location_always', 'location', 'motion'] as const).flatMap((permission) =>
    (['ios', 'android'] as const).map((platform) =>
      renderPush('permission_lapsed', { permission, platform, deviceId: 'd' })
    )
  );
  const rewards = [
    ...[7, 14, 30, 50, 100, 150, 200, 250, 300, 365, 10000].map((days) =>
      renderPush('streak_milestone', { days, reachedOn: '2026-09-21' })
    ),
    ...(['phone', 'speeding', 'braking', 'cornering', 'accel'] as const).flatMap((category) =>
      [false, true].map((prorated) =>
        renderPush('goal_completed', { kind: 'weekly_goal', category, weekStart: '2026-09-14', points: 1000, prorated })
      )
    ),
    ...(['phone_down', 'within_limit', 'smooth_ride', 'safe_run'] as const).map((challengeId) =>
      renderPush('goal_completed', { kind: 'challenge', challengeId, points: 1000 })
    ),
    ...(
      [
        [2, 'Steady'],
        [3, 'Smooth'],
        [4, 'Focused'],
        [5, 'Road-wise'],
        [6, 'Mentor'],
      ] as const
    ).map(([level, name]) => renderPush('level_up', { kind: 'level', level, name })),
    ...(['bronze', 'silver', 'gold'] as const).map((tier) =>
      renderPush('level_up', { kind: 'badge', badgeId: 'safe_days_100', tier })
    ),
    ...(['invitee', 'referrer'] as const).map((role) => renderPush('referral_qualified', { role, points: 1000 })),
  ];
  const all = [...locals, ...pushes, ...rewards].map((c) => {
    if (!c) throw new Error('a live variant rendered nothing');
    return c;
  });

  test('fits: title ≤ 40, body ≤ 140', () => {
    for (const c of all) {
      expect(c.title.length).toBeLessThanOrEqual(40);
      expect(c.body.length).toBeLessThanOrEqual(140);
    }
  });

  test('makes no banned promise', () => {
    for (const c of all) {
      for (const re of BANNED_COPY) {
        expect(c.title).not.toMatch(re);
        expect(c.body).not.toMatch(re);
      }
    }
  });

  test('no local string claims a result', () => {
    for (const c of locals) {
      expect(c.title).not.toMatch(CLAIMS_RESULT);
      expect(c.body).not.toMatch(CLAIMS_RESULT);
    }
  });

  test('the banned list catches what it is meant to catch', () => {
    const caught = (s: string) => BANNED_COPY.some((re) => re.test(s));
    for (const s of [
      'Your score never lowers',
      "It can't go down",
      'Nothing is lost',
      'You can delete everything',
      'Download your data',
      "You're about to lose your streak",
      'Last chance',
      'Great drive!',
      '+150 points you can redeem',
      'worth $5',
      "Don't lose your streak!",
      'Earn cash',
      'Points are money',
      'Win a gift card',
      'A prize for you',
      'Lower insurance',
      'A discount',
      '10 dollars',
    ]) {
      expect(caught(s)).toBe(true);
    }
  });

  test('rewards words themselves are allowed now that M5 builds them', () => {
    const caught = (s: string) => BANNED_COPY.some((re) => re.test(s));
    for (const s of ['+150 points', 'Rewards', 'Your safe-day streak just reached 7', 'A window of time']) {
      expect(caught(s)).toBe(false);
    }
  });

  test('no rewards string names a place, a drive or a person', () => {
    for (const c of rewards) {
      if (!c) throw new Error('a rewards variant rendered nothing');
      for (const s of [c.title, c.body]) expect(s).not.toMatch(/\b(at|near|on) [A-Z]|mi\b|miles?|\d{1,2}:\d{2}|\bAM\b|\bPM\b/);
    }
  });
});
