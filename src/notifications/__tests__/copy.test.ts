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
  const all = [...locals, ...pushes].map((c) => {
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
      'Earn rewards',
      '50 points',
      'Great drive!',
    ]) {
      expect(caught(s)).toBe(true);
    }
  });
});
