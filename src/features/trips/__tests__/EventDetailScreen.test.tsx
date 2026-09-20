import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { createEventsRepo, createQueueRepo, type DisputeRecord } from '@/data/db';
import { eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  clearQueryClients,
  press,
  routerDouble,
  world,
} from '@/features/trips/__fixtures__/render';
import { EventDetailScreen } from '@/features/trips/EventDetailScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ID = 'trip-1';
const EVENT = 'e-speeding';

const trip = tripRow({ client_trip_id: ID, score: 84 });

const speeding = (over: Parameters<typeof eventRow>[0] = {}) =>
  eventRow({
    id: EVENT,
    client_trip_id: ID,
    category: 'speeding',
    started_at: T0 + 60_000,
    duration_s: 38,
    deduction: 6,
    severity: '3.5',
    confidence: 0.9,
    measured_json: JSON.stringify({ speedMps: 21, limitMps: 15.6, overMps: 5.4 }),
    ...over,
  });

const record = (over: Partial<DisputeRecord>) =>
  JSON.stringify({
    reason: 'hazard',
    note: null,
    statedLimitMph: null,
    submittedAt: T0,
    outcome: 'queued',
    deniedReason: null,
    remainingAllowance: null,
    code: null,
    decidedAt: null,
    ...over,
  });

const open = async (events = [speeding()], trips = [trip]) => {
  const w = await world({ trips, events });
  await w.renderScreen(<EventDetailScreen clientTripId={ID} eventId={EVENT} />);
  await screen.findByTestId('event-detail');
  return w;
};

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
});
afterEach(clearQueryClients);

describe('the moment itself', () => {
  test('prints what was measured, how sure we are and what it cost', async () => {
    await open();
    expect(screen.getByTestId('measured')).toHaveTextContent('47 mph in a 35 zone for 38 s');
    expect(screen.getByText('High confidence')).toBeOnTheScreen();
    expect(screen.getByTestId('confidence-reasons')).toHaveTextContent(
      'Speed from GPS · speed limit from map data'
    );
    expect(screen.getByTestId('event-points')).toHaveTextContent('−6');
    expect(screen.getByText(/Every extra mph adds stopping distance/)).toBeOnTheScreen();
  });

  test('a moment on a drive that is not on the record is an empty state, not a blank screen', async () => {
    const w = await world();
    await w.renderScreen(<EventDetailScreen clientTripId={ID} eventId={EVENT} />);
    expect(await screen.findByText("This moment isn't on the drive")).toBeOnTheScreen();
  });

  test('a low-confidence moment says it was detected and did not count, and why', async () => {
    await open([speeding({ status: 'possible', deduction: 0, confidence: 0.4 })]);
    expect(screen.getByText('Detected, not counted')).toBeOnTheScreen();
    expect(
      screen.getByText("We weren't sure enough about this one, so it didn't affect your score.")
    ).toBeOnTheScreen();
    expect(screen.getByTestId('event-points')).toHaveTextContent('None');
    // It can still be reported: the driver may know it never happened at all.
    expect(screen.getByRole('button', { name: "This isn't right" })).toBeOnTheScreen();
  });
});

describe('reporting it', () => {
  test('the six reasons are the spec words, in order, as a radio group', async () => {
    await open();
    await press(screen.getByRole('button', { name: "This isn't right" }));
    const reasons = [
      "I wasn't the driver",
      'A passenger was using my phone',
      'The speed limit is wrong',
      'I had to — avoiding a hazard / emergency',
      'My phone fell or moved',
      'Other',
    ];
    for (const reason of reasons) {
      expect(screen.getByRole('radio', { name: reason })).toBeOnTheScreen();
    }
  });

  test('a report is written locally, queued for the server, and says so', async () => {
    const w = await open();
    await press(screen.getByRole('button', { name: "This isn't right" }));
    await press(screen.getByTestId('reason-hazard'));
    await press(screen.getByTestId('dispute-submit'));

    expect(await screen.findByTestId('report-saved')).toBeOnTheScreen();
    expect(screen.getByText("Saved. We'll send it when you're online.")).toBeOnTheScreen();

    const stored = await createEventsRepo(w.db).get(EVENT);
    expect(stored).toMatchObject({ status: 'disputed' });
    expect(JSON.parse(stored?.dispute_json ?? 'null')).toMatchObject({
      reason: 'hazard',
      outcome: 'queued',
    });

    const [item] = await createQueueRepo(w.db).nextDue(Date.now() + 1, 10);
    expect(item).toMatchObject({ kind: 'dispute', idempotency_key: `dispute:${EVENT}` });
    expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({
      action: 'dispute',
      clientEventId: EVENT,
      reason: 'hazard',
    });
  });

  test('a stated posted limit rides along, and is free', async () => {
    const w = await open();
    await press(screen.getByRole('button', { name: "This isn't right" }));
    await press(screen.getByTestId('reason-wrong_limit'));
    expect(
      screen.getByText("A posted limit you tell us is free — it doesn't use up a report.")
    ).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('stated-limit'), '45');
    await press(screen.getByTestId('dispute-submit'));

    await waitFor(async () => {
      const [item] = await createQueueRepo(w.db).nextDue(Date.now() + 1, 10);
      expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({
        action: 'dispute',
        clientEventId: EVENT,
        reason: 'wrong_limit',
        statedLimitMph: 45,
      });
    });
  });

  test('free text rides along only for Other, and is trimmed', async () => {
    const w = await open();
    await press(screen.getByRole('button', { name: "This isn't right" }));
    await press(screen.getByTestId('reason-other'));
    await fireEvent.changeText(screen.getByTestId('dispute-note'), '  the road was closed  ');
    await press(screen.getByTestId('dispute-submit'));

    await waitFor(async () => {
      const [item] = await createQueueRepo(w.db).nextDue(Date.now() + 1, 10);
      expect(JSON.parse(item?.payload_json ?? 'null')).toEqual({
        action: 'dispute',
        clientEventId: EVENT,
        reason: 'other',
        note: 'the road was closed',
      });
    });
  });

  test('"I wasn\'t the driver" is about the whole drive, and goes to the edit screen instead', async () => {
    const w = await open();
    await press(screen.getByRole('button', { name: "This isn't right" }));
    await press(screen.getByTestId('reason-not_driver'));

    expect(screen.getByTestId('not-driver-note')).toBeOnTheScreen();
    expect(
      screen.getByText(
        "If you weren't driving, the whole drive comes off your score — not just this moment."
      )
    ).toBeOnTheScreen();

    await press(screen.getByRole('button', { name: 'Change who was driving' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/trips/[clientTripId]/edit',
      params: { clientTripId: ID },
    });
    // Nothing was reported about this one moment.
    const [item] = await createQueueRepo(w.db).nextDue(Date.now() + 1, 10);
    expect(item).toBeUndefined();
  });

  test('nothing can be sent until a reason is picked', async () => {
    await open();
    await press(screen.getByRole('button', { name: "This isn't right" }));
    expect(screen.getByTestId('dispute-submit')).toBeDisabled();
  });
});

describe('what the server said', () => {
  test('a report on its way says so, and is not offered a second time', async () => {
    await open([speeding({ status: 'disputed', dispute_json: record({ outcome: 'queued' }) })]);
    expect(screen.getByText('Reported — sending')).toBeOnTheScreen();
    expect(
      screen.getByText("Your report is saved. We'll send it the next time you're online.")
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: "This isn't right" })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to the drive' })).toBeOnTheScreen();
  });

  test('an accepted report says the moment was removed from the score', async () => {
    await open([
      speeding({
        status: 'removed',
        deduction: 0,
        corrected: 1,
        dispute_json: record({ outcome: 'accepted', remainingAllowance: 2, decidedAt: T0 }),
      }),
    ]);
    expect(screen.getByText('Removed from score (your report)')).toBeOnTheScreen();
    expect(screen.getByTestId('event-points')).toHaveTextContent('None');
  });

  test('a report beyond the allowance is honest: recorded, and it did not change the score', async () => {
    await open([
      speeding({ dispute_json: record({ outcome: 'denied', deniedReason: 'allowance_7d' }) }),
    ]);
    expect(screen.getByText('Reported')).toBeOnTheScreen();
    expect(
      screen.getByText(
        "You've used your reports for now, so this one didn't change your score. We still logged it, and it helps us fix what flagged you."
      )
    ).toBeOnTheScreen();
    // The points it cost are still on the row: nothing was applied.
    expect(screen.getByTestId('event-points')).toHaveTextContent('−6');
  });

  test('a report past the window says the window closed, not that something went wrong', async () => {
    await open([
      speeding({
        dispute_json: record({ outcome: 'window_closed', code: 'dispute_window_closed' }),
      }),
    ]);
    expect(screen.getByText('Reported too late')).toBeOnTheScreen();
    expect(
      screen.getByText("Reports close 14 days after a drive, so this one couldn't be applied.")
    ).toBeOnTheScreen();
  });
});
