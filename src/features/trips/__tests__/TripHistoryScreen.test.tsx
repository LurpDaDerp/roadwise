import { screen, waitFor } from '@testing-library/react-native';

import { createQueueRepo } from '@/data/db';
import { deductions, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  brokenDb,
  clearQueryClients,
  press,
  routerDouble,
  world,
} from '@/features/trips/__fixtures__/render';
import { PAGE_SIZE, TripHistoryScreen } from '@/features/trips/TripHistoryScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const DAY = 86_400_000;

const drive = (id: string, daysAgo: number, over: Parameters<typeof tripRow>[0] = {}) =>
  tripRow({ client_trip_id: id, started_at: T0 - daysAgo * DAY, ...over });

const open = async (seed: Parameters<typeof world>[0] = {}) => {
  const w = await world(seed);
  await w.renderScreen(<TripHistoryScreen />);
  await screen.findByTestId('trip-history');
  return w;
};

beforeEach(() => mockRouter.push.mockClear());
afterEach(clearQueryClients);

describe('the list', () => {
  test('groups drives under the day they were driven, newest first', async () => {
    await open({
      trips: [drive('a', 0), drive('b', 0, { started_at: T0 - 3600_000 }), drive('c', 1)],
    });
    expect(screen.getByTestId('day-2026-01-05')).toBeOnTheScreen();
    expect(screen.getByTestId('day-2026-01-04')).toBeOnTheScreen();
    expect(screen.getByTestId('history-a')).toBeOnTheScreen();
    expect(screen.getByTestId('history-b')).toBeOnTheScreen();
    expect(screen.getByTestId('history-c')).toBeOnTheScreen();
  });

  test('a row reads as one thing: when, where, the score, how far, who drove, conditions', async () => {
    await open({ trips: [drive('a', 0, { score: 84 })] });
    const label = screen.getByTestId('history-a').props.accessibilityLabel as string;
    expect(label).toContain('Near Home to Near Lincoln HS');
    expect(label).not.toContain('→');
    expect(label).toContain('84, Good');
    expect(label).toContain('10 mi');
    expect(label).toContain('You drove');
    expect(label).toContain('Day');
  });

  test('a day the server called safe wears the stamp; a plain day wears nothing', async () => {
    await open({
      trips: [drive('a', 0), drive('c', 1)],
      days: [['2026-01-05', { day: '2026-01-05', safeDay: true, goodDay: false }]],
    });
    expect(screen.getByTestId('stamp-safe-day')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Safe day')).toHaveLength(1);
  });

  test('tapping a drive opens its summary', async () => {
    await open({ trips: [drive('a', 0)] });
    await press(screen.getByTestId('history-a'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/trips/[clientTripId]/summary',
      params: { clientTripId: 'a' },
    });
  });

  test('the retention notice closes the list, where the question is actually asked', async () => {
    await open({ trips: [drive('a', 0)] });
    expect(screen.getByTestId('retention-notice')).toHaveTextContent(
      "That's every drive on this phone. Drives stay until you delete them; the detailed route is kept for 90 days."
    );
  });

  test('a deleted drive is gone from the list at once', async () => {
    await open({ trips: [drive('a', 0), drive('b', 0, { deleted_at: T0 })] });
    expect(screen.getByTestId('history-a')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-b')).toBeNull();
  });

  test('a delete the server was never told about is said out loud, and can be asked again', async () => {
    const w = await world({
      trips: [
        drive('a', 0),
        drive('b', 0, { deleted_at: T0, sync_state: 'failed', sync_error: 'retries_exhausted' }),
      ],
    });
    // The queue is where "the delete gave up" actually lives: an item this build has failed.
    await w.db.execute(
      'INSERT INTO sync_queue (kind, payload_json, idempotency_key, status, attempts,' +
        ' next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        'delete-trip',
        JSON.stringify({ action: 'delete', clientTripId: 'b' }),
        'delete:b',
        'failed',
        20,
        T0,
        T0,
      ]
    );
    await w.renderScreen(<TripHistoryScreen />);
    await screen.findByTestId('trip-history');

    expect(screen.getByTestId('delete-failed')).toBeOnTheScreen();
    expect(
      screen.getByText(
        "One drive couldn't be deleted yet. It's gone from your phone, but still on our side."
      )
    ).toBeOnTheScreen();
    // The drive itself stays hidden: there is nothing left of it to show.
    expect(screen.queryByTestId('history-b')).toBeNull();

    await press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(async () => {
      expect(await createQueueRepo(w.db).byKey('delete:b')).toMatchObject({
        status: 'pending',
        attempts: 0,
      });
    });
    expect(screen.queryByTestId('delete-failed')).toBeNull();
  });

  test('a drive whose upload failed for its own reasons raises no delete notice', async () => {
    // `trips.sync_error` is set by a refused upload too. The banner is about deletes, and reads
    // the queue rather than the row, so this drive is simply a drive.
    await open({
      trips: [drive('a', 0, { sync_state: 'failed', sync_error: 'trip_too_old' })],
    });
    expect(screen.queryByTestId('delete-failed')).toBeNull();
    expect(screen.getByTestId('history-a')).toBeOnTheScreen();
  });
});

describe('states', () => {
  test('is drawn as a skeleton while it loads, never a spinner', async () => {
    const w = await world({ trips: [drive('a', 0)] });
    await w.renderScreen(<TripHistoryScreen />);
    // The list arrives; the shape it replaced was a skeleton under a progressbar.
    expect(await screen.findByTestId('trip-history')).toBeOnTheScreen();
  });

  test('a database that cannot be read says so and offers a retry', async () => {
    const w = await world();
    await w.renderScreen(<TripHistoryScreen />, brokenDb());
    expect(await screen.findByText("Couldn't open your drives.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  test('with no drives at all it says where the first one lands', async () => {
    await open();
    expect(screen.getByText('No drives yet')).toBeOnTheScreen();
    expect(screen.getByText('Your first recorded drive lands here.')).toBeOnTheScreen();
  });
});

describe('filters', () => {
  const mixed = {
    trips: [
      drive('driver-good', 0, { score: 84, role: 'driver' }),
      drive('passenger', 0, { role: 'passenger', score: null, status: 'unscored' }),
      drive('speeder', 1, {
        score: 62,
        category_deductions_json: JSON.stringify(deductions({ speeding: 12 })),
      }),
    ],
  };

  test('are collapsed until they are asked for, and every option is a radio with a state', async () => {
    await open(mixed);
    expect(screen.queryByTestId('filters-panel')).toBeNull();
    await press(screen.getByTestId('filters-toggle'));
    expect(screen.getByTestId('filters-panel')).toBeOnTheScreen();

    // Each group always has something checked: "All" is an option, not a cleared state.
    expect(screen.getByTestId('filter-role-all')).toBeChecked();
    expect(screen.getByTestId('filter-role-driver')).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'You drove' })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Excellent' })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Speeding' })).toBeOnTheScreen();
  });

  test('who was driving narrows the list', async () => {
    await open(mixed);
    await press(screen.getByTestId('filters-toggle'));
    await press(screen.getByTestId('filter-role-passenger'));
    expect(await screen.findByTestId('history-passenger')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-driver-good')).toBeNull();
  });

  test('the score band narrows the list', async () => {
    await open(mixed);
    await press(screen.getByTestId('filters-toggle'));
    await press(screen.getByTestId('filter-band-good'));
    expect(await screen.findByTestId('history-driver-good')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-speeder')).toBeNull();
  });

  test('what came up narrows the list to drives that category actually cost points on', async () => {
    await open(mixed);
    await press(screen.getByTestId('filters-toggle'));
    await press(screen.getByTestId('filter-category-speeding'));
    expect(await screen.findByTestId('history-speeder')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-driver-good')).toBeNull();
  });

  test('a filter that matches nothing says so and offers to clear it', async () => {
    await open({ trips: [drive('a', 0, { score: 84 })] });
    await press(screen.getByTestId('filters-toggle'));
    await press(screen.getByTestId('filter-band-needs_focus'));
    expect(await screen.findByText('No drives match')).toBeOnTheScreen();
    await press(screen.getByTestId('filters-clear'));
    expect(await screen.findByTestId('history-a')).toBeOnTheScreen();
  });

  test('the control says how many filters are on', async () => {
    await open(mixed);
    await press(screen.getByTestId('filters-toggle'));
    await press(screen.getByTestId('filter-role-driver'));
    expect(await screen.findByLabelText('Filters, 1')).toBeOnTheScreen();
  });
});

describe('paging', () => {
  const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
    drive(`t${String(i).padStart(2, '0')}`, i)
  );

  test('a backlog longer than a page offers older drives, and stops offering when they are all in', async () => {
    await open({ trips: many });
    expect(screen.getByTestId('history-t00')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Show older drives' })).toBeOnTheScreen();

    await press(screen.getByRole('button', { name: 'Show older drives' }));

    // The second page brings the remaining five, so there is nothing left to ask for.
    expect(screen.queryByRole('button', { name: 'Show older drives' })).toBeNull();
    expect(screen.getByTestId('retention-notice')).toBeOnTheScreen();
  });

  test('once everything is on screen there is nothing more to load', async () => {
    await open({ trips: [drive('a', 0)] });
    expect(screen.queryByRole('button', { name: 'Show older drives' })).toBeNull();
    expect(screen.getByTestId('retention-notice')).toBeOnTheScreen();
  });
});
