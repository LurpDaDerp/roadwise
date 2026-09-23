import { act, screen, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { setHydrationStatus } from '@/data/hydrate/status';
import { T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { formatAsOfDay } from '@/features/home/format';
import { inLearningPeriod, LicenceCard } from '@/features/home/LicenceCard';
import { setOnline } from '@/features/inbox/__fixtures__/harness';
import { RewardsDataError, type RewardsSnapshot } from '@/features/rewards/api';
import { writeCachedRewards } from '@/features/rewards/cache';
import { NOT_MONEY } from '@/features/rewards/copy/common';
import { progressRow, rewardDayRow, snapshot, UID } from '@/features/rewards/__fixtures__/rows';
import { clearQueryClients, press, routerDouble, world } from '@/features/trips/__fixtures__/render';
import { BANNED_COPY } from '@/notifications/catalog';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/lib/deviceZone', () => ({ deviceZone: () => 'UTC' }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
/** The rewards server as this suite answers it: `answer` decides each fetch. */
const mockRewardsServer: { answer: () => Promise<RewardsSnapshot>; fetches: number } = {
  answer: () => Promise.reject(new Error('set in beforeEach')),
  fetches: 0,
};
jest.mock('@/features/rewards/api', () => {
  const actual = jest.requireActual<typeof import('@/features/rewards/api')>('@/features/rewards/api');
  return {
    ...actual,
    defaultRewardsApi: {
      ...actual.defaultRewardsApi,
      fetchSnapshot: () => {
        mockRewardsServer.fetches += 1;
        return mockRewardsServer.answer();
      },
    },
  };
});

/** Monday 26 January 2026, noon UTC. */
const NOW = Date.UTC(2026, 0, 26, 12);
const now = () => NOW;
const DAY = 86_400_000;

const dayRow = (day: string, longTermScore: number | null, over: Record<string, unknown> = {}) => ({
  day,
  longTermScore,
  band: longTermScore === null ? null : 'good',
  provisional: longTermScore === null,
  safeDay: false,
  goodDay: false,
  phoneFreeDay: false,
  cameraDay: false,
  exposure: 1,
  drivingS: 1800,
  tripsScored: 1,
  severeEvents: 0,
  ...over,
});

const drive = (id: string, daysAgo: number, over: Parameters<typeof tripRow>[0] = {}) =>
  tripRow({ client_trip_id: id, started_at: T0 - daysAgo * DAY, sync_state: 'synced', ...over });

/** A user with no rewards yet: no progress row, no goal, no days. */
const newUser = () =>
  snapshot({ progress: null, currentGoal: null, lastGoal: null, days: [], badges: [], challenges: [] });

beforeEach(() => {
  mockRewardsServer.answer = async () => snapshot();
  mockRewardsServer.fetches = 0;
  mockRouter.push.mockClear();
  // The stamp's thump is a spring; reduce motion keeps Jest out of Reanimated's frame loop.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(async () => {
  clearQueryClients();
  setOnline(null);
  await act(async () => {
    setHydrationStatus({ state: 'idle' });
  });
});

describe('the score (R9: the server value, always dated)', () => {
  test("prints the newest day's score with its band and the day it was computed, and speaks it", async () => {
    const w = await world(
      {
        trips: [drive('a', 3), drive('b', 2), drive('c', 1)],
        days: [
          ['2026-01-12', dayRow('2026-01-12', 79)],
          ['2026-01-19', dayRow('2026-01-19', 86)],
        ],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya Chen" />);

    expect(await screen.findByText('86')).toBeOnTheScreen();
    expect(screen.getByText('Good')).toBeOnTheScreen();
    expect(screen.getByText('as of Jan 19')).toBeOnTheScreen();
    expect(screen.getByLabelText('Long-term score 86 of 100, Good, as of January 19')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Maya Chen' })).toBeOnTheScreen();
    // A scored card is past the learning period.
    expect(screen.queryByTestId('learning-stamp')).toBeNull();
  });

  test('names only the drives that can still move the score as waiting to sync', async () => {
    const w = await world(
      {
        trips: [
          drive('synced', 4),
          drive('queued', 1, { sync_state: 'queued' }),
          drive('uploading', 0, { sync_state: 'uploading' }),
          // Neither of these can move the score: a passenger drive and a failed upload.
          drive('passenger', 1, { sync_state: 'queued', role: 'passenger', score: null, status: 'unscored' }),
          drive('failed', 2, { sync_state: 'failed' }),
        ],
        days: [['2026-01-19', dayRow('2026-01-19', 86)]],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya" />);

    expect(await screen.findByText('2 drives waiting to sync')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Long-term score 86 of 100, Good, as of January 19. 2 drives waiting to sync')
    ).toBeOnTheScreen();
  });

  test('one pending drive is singular', async () => {
    const w = await world(
      {
        trips: [drive('queued', 1, { sync_state: 'queued' })],
        days: [['2026-01-19', dayRow('2026-01-19', 86)]],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByText('1 drive waiting to sync')).toBeOnTheScreen();
  });

  test('a score computed in an earlier year says which year', () => {
    expect(formatAsOfDay('2025-12-30', NOW)).toEqual({ printed: 'Dec 30, 2025', spoken: 'December 30, 2025' });
    expect(formatAsOfDay('2026-01-19', NOW)).toEqual({ printed: 'Jan 19', spoken: 'January 19' });
  });

  test('building: counts toward three drives, with the learning-period stamp', async () => {
    const w = await world({ trips: [drive('a', 1)], days: [['2026-01-19', dayRow('2026-01-19', null)]] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    expect(await screen.findByText('Building your score: 1 of 3 drives')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Long-term score not ready yet. Building your score: 1 of 3 drives')
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Provisional')).toBeOnTheScreen();
    expect(screen.queryByText(/as of/)).toBeNull();
  });

  test('building with three drives already: what is missing is driving time, not a count', async () => {
    const w = await world(
      {
        trips: [drive('a', 3), drive('b', 2), drive('c', 1)],
        days: [['2026-01-19', dayRow('2026-01-19', null)]],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(
      await screen.findByText('Building your score: it appears after an hour of scored driving')
    ).toBeOnTheScreen();
    expect(screen.queryByText('Building your score: 3 of 3 drives')).toBeNull();
  });

  test('a new driver with nothing yet builds from zero', async () => {
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name={null} />);
    expect(await screen.findByText('Building your score: 0 of 3 drives')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'New driver' })).toBeOnTheScreen();
  });

  test('waiting: scored drives on this phone, no server row yet', async () => {
    const w = await world({ trips: [drive('a', 1, { sync_state: 'queued' })] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByText('Your score appears when your drives sync')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Long-term score not ready yet. It appears when your drives sync')
    ).toBeOnTheScreen();
  });

  test('restoring: never "Building" while a restore is owed, running or cut short', async () => {
    setHydrationStatus({ state: 'restoring', restored: 0 });
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    // The score is read from this phone's drives, so it waits for the restore; the rewards fields
    // are the server's settled values and do not.
    expect(await screen.findByText('Restoring…')).toBeOnTheScreen();
    expect(screen.getByLabelText('Long-term score: restoring your drives from the server')).toBeOnTheScreen();
    expect(screen.queryByText(/Building your score/)).toBeNull();
    // The learning period is not asserted while the history is unknown.
    expect(screen.queryByTestId('learning-stamp')).toBeNull();

    await act(async () => {
      setHydrationStatus({ state: 'failed', at: NOW });
    });
    expect(screen.getByLabelText('Long-term score: restoring your drives from the server')).toBeOnTheScreen();
    expect(screen.queryByText(/Building your score/)).toBeNull();
  });
});

describe('the rewards fields: CLASS, STREAK, SAFE DAYS and POINTS (M5, D13)', () => {
  test('a mid user: the class, the streak with its shields as text, and points', async () => {
    mockRewardsServer.answer = async () =>
      snapshot({
        progress: progressRow({ xp: 2000, points: 1250, streak_days: 12, best_streak: 12, shields: 2, safe_days: 31 }),
      });
    const w = await world({ days: [['2026-01-19', dayRow('2026-01-19', 86)]] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    const region = await screen.findByRole('button', {
      name: 'Class Steady. Streak 12 days, 2 shields. 1,250 points. Opens rewards',
    });
    expect(within(region).getByText('Steady')).toBeOnTheScreen();
    expect(within(region).getByText('12')).toBeOnTheScreen();
    expect(within(region).getByText('2 shields')).toBeOnTheScreen();
    expect(within(region).getByText('1,250')).toBeOnTheScreen();
    expect(screen.getByLabelText('Safe days, 31')).toBeOnTheScreen();
    // The score beside them is untouched.
    expect(screen.getByText('86')).toBeOnTheScreen();
  });

  test('the region opens the rewards tab', async () => {
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    await press(await screen.findByTestId('licence-rewards'));
    expect(mockRouter.push).toHaveBeenCalledWith('/rewards');
  });

  test('a new user: 0 safe days, Learner, 0 points, and no stamp claimed for any of it', async () => {
    mockRewardsServer.answer = async () => newUser();
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name={null} />);

    expect(
      await screen.findByRole('button', { name: 'Class Learner. Streak 0 days. 0 points. Opens rewards' })
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Safe days, 0')).toBeOnTheScreen();
    expect(screen.queryByTestId('safe-days-provisional')).toBeNull();
    // The one stamp is the learning period's (the score is still building), never the rewards'.
    expect(screen.getAllByLabelText('Provisional')).toHaveLength(1);
  });

  test('a restarted streak reads 0 and keeps the best worth showing; one shield is singular', async () => {
    mockRewardsServer.answer = async () =>
      snapshot({ progress: progressRow({ xp: 5000, points: 5000, streak_days: 0, best_streak: 30, shields: 1 }) });
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    const region = await screen.findByRole('button', {
      name: 'Class Smooth. Streak 0 days, best 30, 1 shield. 5,000 points. Opens rewards',
    });
    expect(within(region).getByText('Best 30')).toBeOnTheScreen();
    expect(within(region).getByText('1 shield')).toBeOnTheScreen();
    expect(within(region).queryByText(/in a row/i)).toBeNull();
  });

  test('one streak day and one point are singular', async () => {
    mockRewardsServer.answer = async () =>
      snapshot({ progress: progressRow({ xp: 0, points: 1, streak_days: 1, best_streak: 1, shields: 0 }) });
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(
      await screen.findByRole('button', { name: 'Class Learner. Streak 1 day. 1 point. Opens rewards' })
    ).toBeOnTheScreen();
  });

  test('SAFE DAYS is the settled count (progress.safe_days), even when the day rows disagree', async () => {
    mockRewardsServer.answer = async () => snapshot({ progress: progressRow({ safe_days: 1 }) });
    const w = await world(
      {
        days: [
          ['2026-01-12', dayRow('2026-01-12', 84, { safeDay: true })],
          ['2026-01-13', dayRow('2026-01-13', 84, { safeDay: true })],
          ['2026-01-19', dayRow('2026-01-19', 86, { safeDay: true })],
        ],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 1')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Safe days, 3')).toBeNull();
  });

  test('rewards began after this phone\'s first drive: SAFE DAYS says since when (m1)', async () => {
    mockRewardsServer.answer = async () =>
      snapshot({ progress: progressRow({ safe_days: 0, rewards_start: '2026-01-15' }) });
    // T0 is 2026-01-05: this drive is from before the rewards began.
    const w = await world({ trips: [drive('old', 0)] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 0, since January 15')).toBeOnTheScreen();
    expect(screen.getByText('since Jan 15')).toBeOnTheScreen();
  });

  test('no footnote when every drive is from the rewards on, or rewards_start is not set', async () => {
    mockRewardsServer.answer = async () =>
      snapshot({ progress: progressRow({ safe_days: 3, rewards_start: '2026-01-05' }) });
    const w = await world({ trips: [drive('same-day', 0), drive('later', -2)] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 3')).toBeOnTheScreen();
    expect(screen.queryByTestId('licence-safe-days-since')).toBeNull();
    clearQueryClients();

    mockRewardsServer.answer = async () => snapshot({ progress: progressRow({ safe_days: 3, rewards_start: null }) });
    const w2 = await world({ trips: [drive('old', 30)] }, now);
    await w2.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 3')).toBeOnTheScreen();
    expect(screen.queryByTestId('licence-safe-days-since')).toBeNull();
  });

  test("the streak is the server's streak_days, never recounted from the settled days", async () => {
    mockRewardsServer.answer = async () =>
      snapshot({
        progress: progressRow({ xp: 0, points: 150, streak_days: 2, shields: 0 }),
        days: ['2026-09-22', '2026-09-21', '2026-09-20', '2026-09-19'].map((d) => rewardDayRow(d)),
      });
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(
      await screen.findByRole('button', { name: 'Class Learner. Streak 2 days. 150 points. Opens rewards' })
    ).toBeOnTheScreen();
  });

  test('while the rewards load, their fields are skeletons and the score is printed', async () => {
    let finish: (s: RewardsSnapshot) => void = () => {};
    mockRewardsServer.answer = () => new Promise((resolve) => (finish = resolve));
    const w = await world({ days: [['2026-01-19', dayRow('2026-01-19', 86)]] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    expect(await screen.findByText('86')).toBeOnTheScreen();
    expect(screen.getByTestId('licence-rewards-loading')).toBeOnTheScreen();
    expect(screen.getByTestId('licence-safe-days-loading', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByTestId('licence-rewards')).toBeNull();

    await act(async () => finish(snapshot()));
    expect(await screen.findByTestId('licence-rewards')).toBeOnTheScreen();
  });

  test('an unreadable answer: the rewards say so with a retry, and the score still stands', async () => {
    mockRewardsServer.answer = async () => {
      throw new RewardsDataError('progress');
    };
    const w = await world({ days: [['2026-01-19', dayRow('2026-01-19', 86)]] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    expect(await screen.findByText("Couldn't read your rewards.")).toBeOnTheScreen();
    expect(screen.getByLabelText('Long-term score 86 of 100, Good, as of January 19')).toBeOnTheScreen();
    // Every rewards field is an honest dash, never a zero.
    expect(within(screen.getByTestId('licence-rewards-error')).getAllByText('—', { includeHiddenElements: true })).toHaveLength(3);
    expect(screen.getByLabelText("Safe days: Couldn't read your rewards.")).toBeOnTheScreen();
    expect(screen.queryByText('0')).toBeNull();

    mockRewardsServer.answer = async () => snapshot({ progress: progressRow({ safe_days: 12 }) });
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Safe days, 12')).toBeOnTheScreen();
    expect(screen.queryByText("Couldn't read your rewards.")).toBeNull();
  });

  test('offline with nothing saved on this phone: the true cause, not a failure', async () => {
    setOnline(false);
    const w = await world({ days: [['2026-01-19', dayRow('2026-01-19', 86)]] }, now);
    await w.renderScreen(<LicenceCard name="Maya" />);

    expect(await screen.findByText("Your rewards appear when you're online.")).toBeOnTheScreen();
    expect(screen.queryByText("Couldn't read your rewards.")).toBeNull();
    expect(screen.getByText('86')).toBeOnTheScreen();
    // Offline, the phone never asks the server.
    expect(mockRewardsServer.fetches).toBe(0);
  });

  test('offline with rewards saved on this phone: the saved values are printed', async () => {
    const w = await world({}, now);
    await writeCachedRewards(
      createSettingsRepo(w.db),
      UID,
      snapshot({ progress: progressRow({ xp: 2000, points: 1250, streak_days: 12, shields: 2 }) })
    );
    setOnline(false);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(
      await screen.findByRole('button', { name: 'Class Steady. Streak 12 days, 2 shields. 1,250 points. Opens rewards' })
    ).toBeOnTheScreen();
    expect(mockRewardsServer.fetches).toBe(0);
  });

  test('the printed rewards text passes BANNED_COPY (no money, pressure or "!")', async () => {
    mockRewardsServer.answer = async () =>
      snapshot({ progress: progressRow({ xp: 2000, points: 1250, streak_days: 0, best_streak: 4, shields: 2 }) });
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    const region = await screen.findByTestId('licence-rewards');
    const texts = [
      String(region.props.accessibilityLabel),
      ...within(region)
        .queryAllByText(/.+/)
        .map((n) => String(n.props.children)),
    ].filter((t) => t !== NOT_MONEY);
    expect(texts.length).toBeGreaterThan(4);
    for (const t of texts) for (const re of BANNED_COPY) expect([t, re.test(t)]).toEqual([t, false]);
  });
});

test('the learning period follows what is known, never a guess', () => {
  const base = { score: null, band: null, asOfDay: null, provisional: false, scoredDrives: 0, pendingDrives: 0 };
  expect(inLearningPeriod({ ...base, state: 'restoring' })).toBe(false);
  expect(inLearningPeriod({ ...base, state: 'building', provisional: true })).toBe(true);
  expect(inLearningPeriod({ ...base, state: 'waiting', scoredDrives: 2 })).toBe(true);
  expect(inLearningPeriod({ ...base, state: 'waiting', scoredDrives: 3 })).toBe(false);
  expect(inLearningPeriod({ ...base, state: 'score', score: 86, band: 'good', asOfDay: '2026-01-19' })).toBe(false);
});
