import { act, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { setHydrationStatus } from '@/data/hydrate/status';
import { T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { formatAsOfDay, inLearningPeriod, LicenceCard } from '@/features/home/LicenceCard';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

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

beforeEach(() => {
  // The stamp's thump is a spring; reduce motion keeps Jest out of Reanimated's frame loop.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(async () => {
  clearQueryClients();
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

    expect(await screen.findAllByText('Restoring…')).toHaveLength(2);
    expect(screen.getByLabelText('Long-term score: restoring your drives from the server')).toBeOnTheScreen();
    expect(screen.getByLabelText('Safe days: restoring your drives from the server')).toBeOnTheScreen();
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

describe('safe days', () => {
  test('counts the safe days the server wrote', async () => {
    const w = await world(
      {
        days: [
          ['2026-01-12', dayRow('2026-01-12', 84, { safeDay: true })],
          ['2026-01-13', dayRow('2026-01-13', 84, { safeDay: false, goodDay: true })],
          ['2026-01-19', dayRow('2026-01-19', 86, { safeDay: true })],
        ],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 2')).toBeOnTheScreen();
    expect(screen.queryByTestId('safe-days-provisional')).toBeNull();
  });

  test('a safe day written while the score was provisional stamps the count provisional', async () => {
    const w = await world(
      {
        days: [
          ['2026-01-12', dayRow('2026-01-12', null, { safeDay: true, provisional: true })],
          ['2026-01-19', dayRow('2026-01-19', 86, { safeDay: true })],
        ],
      },
      now
    );
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 2')).toBeOnTheScreen();
    expect(screen.getByTestId('safe-days-provisional')).toBeOnTheScreen();
  });

  test('none yet reads zero', async () => {
    const w = await world({}, now);
    await w.renderScreen(<LicenceCard name="Maya" />);
    expect(await screen.findByLabelText('Safe days, 0')).toBeOnTheScreen();
  });
});

test('STREAK, CLASS and the weekly goal are not printed until M5 makes them real', async () => {
  const w = await world({ days: [['2026-01-19', dayRow('2026-01-19', 86, { safeDay: true })]] }, now);
  await w.renderScreen(<LicenceCard name="Maya" />);
  await screen.findByText('86');
  expect(screen.queryByText(/streak/i)).toBeNull();
  expect(screen.queryByText(/class/i)).toBeNull();
  expect(screen.queryByText(/goal/i)).toBeNull();
});

test('the learning period follows what is known, never a guess', () => {
  const base = { score: null, band: null, asOfDay: null, provisional: false, scoredDrives: 0, pendingDrives: 0 };
  expect(inLearningPeriod({ ...base, state: 'restoring' })).toBe(false);
  expect(inLearningPeriod({ ...base, state: 'building', provisional: true })).toBe(true);
  expect(inLearningPeriod({ ...base, state: 'waiting', scoredDrives: 2 })).toBe(true);
  expect(inLearningPeriod({ ...base, state: 'waiting', scoredDrives: 3 })).toBe(false);
  expect(inLearningPeriod({ ...base, state: 'score', score: 86, band: 'good', asOfDay: '2026-01-19' })).toBe(false);
});
