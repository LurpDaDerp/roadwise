import { screen, waitFor } from '@testing-library/react-native';

import { createEventsRepo, createQueueRepo, createTripsRepo } from '@/data/db';
import { eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  brokenDb,
  clearQueryClients,
  press,
  routerDouble,
  world,
} from '@/features/trips/__fixtures__/render';
import { tripCopy as copy } from '@/features/trips/copy';
import { EditTripScreen } from '@/features/trips/EditTripScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ID = 'trip-1';

const open = async (seed: Parameters<typeof world>[0] = { trips: [tripRow({ client_trip_id: ID })] }) => {
  const w = await world(seed);
  await w.renderScreen(<EditTripScreen clientTripId={ID} />);
  await screen.findByTestId('edit-trip-screen');
  return w;
};

const queued = async (db: Parameters<typeof createQueueRepo>[0]) =>
  createQueueRepo(db).nextDue(Date.now() + 1, 10);

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
  mockRouter.dismissTo.mockClear();
});
afterEach(clearQueryClients);

describe('who was driving', () => {
  test('the three answers are a radio group, with the stored one checked', async () => {
    await open();
    expect(screen.getByRole('radio', { name: 'I drove' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'I was a passenger' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Bus, train, other' })).not.toBeChecked();
  });

  test('a passenger answer takes the drive off the score now, and queues the same body C10 does', async () => {
    const w = await open({ trips: [tripRow({ client_trip_id: ID, score: 84 })] });
    await press(screen.getByTestId('role-passenger'));

    expect(await screen.findByTestId('role-consequence')).toHaveTextContent(
      'This drive no longer counts towards your score.'
    );
    expect(await createTripsRepo(w.db).get(ID)).toMatchObject({
      role: 'passenger',
      score: null,
      status: 'unscored',
      role_source: 'manual',
    });
    const [item] = await queued(w.db);
    expect(item).toMatchObject({ kind: 'set-role' });
    expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({
      action: 'set-role',
      clientTripId: ID,
      role: 'passenger',
    });
  });

  test('a driver answer leaves the score to the server, and says so', async () => {
    const w = await open({
      trips: [tripRow({ client_trip_id: ID, role: 'passenger', score: null, status: 'unscored' })],
    });
    await press(screen.getByTestId('role-driver'));

    expect(await screen.findByTestId('role-consequence')).toHaveTextContent(
      "We'll score this drive again with the new answer the next time you're online."
    );
    expect(await createTripsRepo(w.db).get(ID)).toMatchObject({ role: 'driver' });
  });

  test('a write that fails is answered in place, not with an alert', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID })] });
    await w.renderScreen(<EditTripScreen clientTripId={ID} />);
    await screen.findByTestId('edit-trip-screen');
    // The screen has its rows; the write now meets a database that will not take them.
    Object.assign(w.db, brokenDb());
    await press(screen.getByTestId('role-passenger'));
    expect(await screen.findByTestId('role-error')).toHaveTextContent(
      "Couldn't save that. Try again."
    );
  });

  test('vehicles are named and honestly deferred rather than shown as a dead control', async () => {
    await open();
    expect(screen.getByText('Vehicles are coming soon.')).toBeOnTheScreen();
  });
});

describe('deleting the drive', () => {
  test('every consequence is stated before the destructive button, guardians included', async () => {
    await open();
    await press(screen.getByTestId('delete-trip'));

    expect(screen.getByTestId('delete-consequences')).toBeOnTheScreen();
    expect(
      screen.getByText('The drive, its score and everything on its timeline go for good.')
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Your safety score is worked out again without it. Deleting a drive never makes a day safe. If its day is already confirmed, that day's points and streak stay exactly as they are; in Insights a safe day it was part of may no longer count as one."
      )
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        'If you share summaries with a parent or guardian, they can see that a drive was deleted — never what was on it.'
      )
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Delete drive' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeOnTheScreen();
  });

  test('a drive on a day already credited says that day is final', async () => {
    await open({
      trips: [tripRow({ client_trip_id: ID, sync_state: 'synced' })],
      days: [['2026-01-05', { day: '2026-01-05', safeDay: true }]],
    });
    await press(screen.getByTestId('delete-trip'));
    expect(screen.getByTestId('rewarded-notice')).toBeOnTheScreen();
    expect(
      screen.getByText(
        "This drive is part of a day that's already confirmed. Deleting it doesn't change that day's points or streak — they're final."
      )
    ).toBeOnTheScreen();
  });

  // D2 and R-A: a deleted drive keeps counting against its day, and a confirmed day is final. So
  // no delete copy may say a day is worked out again, or promise that a confirmed day will change.
  test('the delete copy never says a day is recalculated, or that a confirmed day will change', () => {
    const strings = [...copy.edit.deleteConsequence, copy.edit.rewarded, copy.edit.rewardedBody];
    for (const s of strings) {
      expect(s).not.toMatch(/day[^.]*worked out again|worked out again[^.]*day/i);
      expect(s).not.toMatch(/works? the day out again|recalculat/i);
      expect(s).not.toMatch(/(confirmed|credited)[^.]*(will|may|can) (change|go up|go down|be (raised|lowered|taken))/i);
    }
    expect(copy.edit.deleteConsequence[1]).toMatch(/^Your safety score is worked out again without it\./);
    expect(copy.edit.deleteConsequence[1]).toContain('Deleting a drive never makes a day safe.');
    expect(copy.edit.rewardedBody).toContain("they're final");
  });

  test('a drive on an ordinary day carries no such notice', async () => {
    await open();
    await press(screen.getByTestId('delete-trip'));
    expect(screen.queryByTestId('rewarded-notice')).toBeNull();
  });

  test('keeping it changes nothing', async () => {
    const w = await open();
    await press(screen.getByTestId('delete-trip'));
    await press(screen.getByTestId('delete-cancel'));
    expect(await createTripsRepo(w.db).get(ID)).toMatchObject({ deleted_at: null });
    expect(await queued(w.db)).toHaveLength(0);
  });

  test('confirming hides the drive at once, queues the delete, and leaves for the history', async () => {
    const w = await open();
    await press(screen.getByTestId('delete-trip'));
    await press(screen.getByTestId('delete-confirm'));

    await waitFor(async () => {
      const row = await createTripsRepo(w.db).get(ID);
      expect(row?.deleted_at).toEqual(expect.any(Number));
    });
    const [item] = await queued(w.db);
    expect(item).toMatchObject({ kind: 'delete-trip', idempotency_key: `delete:${ID}` });
    expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({ action: 'delete', clientTripId: ID });
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(app)/trips');
  });

  test('nothing identifying about the drive survives the confirmation', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, polyline: 'ceaqGfnqiVaA?' })],
      events: [eventRow({ id: 'e1', client_trip_id: ID })],
    });
    await w.db.execute('INSERT INTO samples (client_trip_id, ts, row_json) VALUES (?, ?, ?)', [
      ID,
      T0,
      '{}',
    ]);
    await w.renderScreen(<EditTripScreen clientTripId={ID} />);
    await screen.findByTestId('edit-trip-screen');

    await press(screen.getByTestId('delete-trip'));
    await press(screen.getByTestId('delete-confirm'));

    await waitFor(async () => {
      const row = await createTripsRepo(w.db).get(ID);
      expect(row?.deleted_at).toEqual(expect.any(Number));
    });

    const row = await createTripsRepo(w.db).get(ID);
    // The husk keeps only what the queued delete needs; every location and label is gone.
    expect(row).toMatchObject({
      polyline: null,
      start_label: null,
      end_label: null,
      start_geohash5: null,
      end_geohash5: null,
    });
    expect(await createEventsRepo(w.db).listByTrip(ID)).toEqual([]);
    const { rows } = await w.db.execute(
      'SELECT count(*) AS n FROM samples WHERE client_trip_id = ?',
      [ID]
    );
    expect(rows[0]?.n).toBe(0);
    // And the request that still has to go is queued, carrying nothing but the id.
    const [item] = await queued(w.db);
    expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({ action: 'delete', clientTripId: ID });
  });

  test('the queued upload goes too, so nothing left in SQLite still holds the route', async () => {
    const w = await open();
    // A finalize body *is* the drive: its polyline, both endpoint geohashes and every event
    // coordinate. Leaving it queued would keep the route the delete was meant to destroy.
    await createQueueRepo(w.db).enqueue(
      'finalize-trip',
      { clientTripId: ID, polyline: 'ceaqGfnqiVaA?', events: [{ lat: 45.5, lng: -122.6 }] },
      `trip:${ID}`,
      T0
    );

    await press(screen.getByTestId('delete-trip'));
    await press(screen.getByTestId('delete-confirm'));

    await waitFor(async () => {
      expect(await createQueueRepo(w.db).byKey(`trip:${ID}`)).toBeNull();
    });
    // What is left is the delete itself, which carries nothing but the id.
    const [item] = await queued(w.db);
    expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({ action: 'delete', clientTripId: ID });
  });

  test('a trace still waiting for Wi-Fi is dropped with the drive', async () => {
    const w = await open();
    await createQueueRepo(w.db).enqueue(
      'trace-upload',
      { clientTripId: ID, tracePath: `${ID}.bin.gz` },
      `trace:${ID}`,
      T0
    );

    await press(screen.getByTestId('delete-trip'));
    await press(screen.getByTestId('delete-confirm'));

    await waitFor(async () => {
      expect(await createQueueRepo(w.db).byKey(`trace:${ID}`)).toBeNull();
    });
  });

  test('a delete that cannot be written says so and stays on the screen', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID })] });
    await w.renderScreen(<EditTripScreen clientTripId={ID} />);
    await screen.findByTestId('edit-trip-screen');
    await press(screen.getByTestId('delete-trip'));
    Object.assign(w.db, brokenDb());
    await press(screen.getByTestId('delete-confirm'));

    expect(await screen.findByText("Couldn't delete that. Try again.")).toBeOnTheScreen();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});

describe('states', () => {
  test('a drive that is not on the record is an empty state', async () => {
    const w = await world();
    await w.renderScreen(<EditTripScreen clientTripId={ID} />);
    expect(await screen.findByText("This drive isn't on your record")).toBeOnTheScreen();
  });

  test('a deleted drive is already gone from here too', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID, deleted_at: T0 })] });
    await w.renderScreen(<EditTripScreen clientTripId={ID} />);
    expect(await screen.findByText("This drive isn't on your record")).toBeOnTheScreen();
  });

  test('a database that cannot be read says so in place, with a retry', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID })] });
    await w.renderScreen(<EditTripScreen clientTripId={ID} />, brokenDb());
    expect(await screen.findByText("Couldn't open this drive.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });
});
