import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { createQueueRepo, createTripsRepo } from '@/data/db';
import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  brokenDb,
  clearQueryClients,
  routerDouble,
  slowDb,
  world,
} from '@/features/trips/__fixtures__/render';
import {
  beforeRewardsDay,
  pendingDay,
  serveRewards,
  settledDay,
} from '@/features/trips/__fixtures__/rewards';
import { TripSummaryScreen } from '@/features/trips/TripSummaryScreen';
import { RewardsOfflineError } from '@/features/rewards/api';
import { BANNED_COPY } from '@/notifications/catalog';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
// The rewards server is the fixture's double, resolved at call time (the fixture reads this module).
jest.mock('@/features/rewards/api', () => ({
  ...jest.requireActual<object>('@/features/rewards/api'),
  defaultRewardsApi: new Proxy(
    {},
    {
      get: (_target, name: string) => (...args: unknown[]) =>
        (
          jest.requireActual<{ rewardsApiDelegate: Record<string, (...a: unknown[]) => unknown> }>(
            '@/features/trips/__fixtures__/rewards'
          ).rewardsApiDelegate[name] as (...a: unknown[]) => unknown
        )(...args),
    }
  ),
}));

const NOW = T0 + 3_600_000;
const ID = 'trip-1';

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.dismissTo.mockClear();
  mockRouter.back.mockClear();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  serveRewards(pendingDay());
});

afterEach(clearQueryClients);

const speedingEvent = (id: string, over: Parameters<typeof eventRow>[0] = {}) =>
  eventRow({ id, client_trip_id: ID, category: 'speeding', deduction: 3, ...over });

/**
 * Drain a `slowDb` until the screen is drawn. The skeleton test's reads each waited 200 ms, and a read can
 * enable the next one (a dependent query starts after its render), so the loaded screen arrives only
 * after several sequential reads: a `findBy` with its 1 s budget raced that chain and lost under load
 * (the full-suite flake). Each step here waits for every pending read, then one tick for React Query's
 * notify and the render (which starts any dependent read), and stops when `done` holds: bounded by steps,
 * never by time.
 */
async function drainUntil(slow: { idle(): Promise<void> }, done: () => boolean): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    await act(async () => {
      await slow.idle();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    if (done()) {
      await act(() => slow.idle());
      return;
    }
  }
  throw new Error('the slow reads never finished drawing the screen');
}

describe('while the row is read', () => {
  test('the card is drawn as a skeleton, never a spinner', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID })] });
    // every read waits 20 ms: long enough that the first render has none, and the drain below is bounded by
    // steps, not by time
    const slow = slowDb(w.db, 20);
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />, slow);
    expect(screen.getByRole('progressbar', { name: 'Loading this drive' })).toBeOnTheScreen();
    // The card, then the timeline, the day and the day's rewards (their cache write goes through the same
    // slow file): all of them land inside the test.
    await drainUntil(
      slow,
      () => screen.queryByText('Near Home → Near Lincoln HS') !== null && screen.queryByTestId('earned-loading') === null
    );
    expect(screen.getByText('Near Home → Near Lincoln HS')).toBeOnTheScreen();
    expect(screen.queryByTestId('earned-loading')).toBeNull();
  });

  test('a database that cannot be read says so in place and offers a retry', async () => {
    const w = await world();
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />, brokenDb());
    expect(await screen.findByText("Couldn't open this drive.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  test('a drive that is not on the record is an empty state, with Done still home', async () => {
    const w = await world();
    await w.renderScreen(<TripSummaryScreen clientTripId="ghost" />);
    expect(await screen.findByText("This drive isn't on your record")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/home');
  });
});

describe('uncertain reading in the highlights', () => {
  const drive = tripRow({
    client_trip_id: ID,
    score: 88,
    category_deductions_json: JSON.stringify(deductions({ speeding: 6 })),
  });

  test('the speeding highlight names the episodes whose reading was uncertain', async () => {
    const w = await world({
      trips: [drive],
      events: [speedingEvent('s1', { confidence: 0.9 }), speedingEvent('s2', { confidence: 0.6 })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Speeding: 2 episodes, 1 uncertain reading')).toBeOnTheScreen();
  });

  test('negative control: confident limits only — no label', async () => {
    const w = await world({
      trips: [drive],
      events: [speedingEvent('s1', { confidence: 0.9 }), speedingEvent('s2', { confidence: 0.85 })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Speeding: 2 episodes')).toBeOnTheScreen();
    expect(screen.queryByText(/uncertain reading/)).toBeNull();
  });
});

describe('a scored drive', () => {
  const scored = tripRow({
    client_trip_id: ID,
    score: 88,
    category_deductions_json: JSON.stringify(deductions({ speeding: 6, braking: 6 })),
    conditions_json: JSON.stringify({ night: true, precipitation: false, hadSevereEvent: false }),
  });

  test('prints the card back: route, date, splits, ring with band, quality stamp, highlights, tip, earned', async () => {
    const w = await world({
      trips: [scored],
      events: [speedingEvent('s1'), speedingEvent('s2'), speedingEvent('p', { status: 'possible', deduction: 0 })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);

    expect(await screen.findByText('Near Home → Near Lincoln HS')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Drive summary' })).toBeOnTheScreen();
    expect(screen.getByText('Mon, Jan 5 · 12:00 – 12:30 PM')).toBeOnTheScreen();
    expect(screen.getByText('30 min')).toBeOnTheScreen();
    expect(screen.getByText('10 mi')).toBeOnTheScreen();
    expect(screen.getByText('Night')).toBeOnTheScreen();

    // A locally provisional score wears the stamp; the ring speaks it in one utterance.
    expect(screen.getByRole('image', { name: 'Score 88, Good, provisional' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Data quality A, Clean signal')).toBeOnTheScreen();

    // Positives first, then the costly category with the two episodes that cost points.
    expect(screen.getByLabelText('No phone use')).toBeOnTheScreen();
    expect(screen.getByLabelText('Speeding: 2 episodes, minus 6 points')).toBeOnTheScreen();
    expect(screen.getByText('−6')).toBeOnTheScreen();

    // The tip is the low-severity speeding tip for a new driver, and it opens D6.
    const tip = screen.getByRole('button', { name: 'Tip: Read the limit, then set it' });
    await fireEvent.press(tip);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/trips/[clientTripId]/tip',
      params: { clientTripId: ID },
    });

    // 88 is a safe-day score; the day is not closed, and the field says so.
    expect(await screen.findByText('Safe day on track')).toBeOnTheScreen();
    expect(screen.getByText('Confirmed when the day closes.')).toBeOnTheScreen();
  });

  test('a pending upload is a chip; a settled one is not', async () => {
    const w = await world({ trips: [scored] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByLabelText('Will sync')).toBeOnTheScreen();
  });

  test('a synced final score has no stamp and no chip, and a good-day score reads as one', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: 75, status: 'final', sync_state: 'synced', category_deductions_json: JSON.stringify(deductions({ phone: 25 })) })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByRole('image', { name: 'Score 75, Getting there' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Will sync')).toBeNull();
    expect(await screen.findByText('Good day on track')).toBeOnTheScreen();
  });

  test('a day the server judged safe is still only on track until it is confirmed: no stamp', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: 60, status: 'final', sync_state: 'synced', category_deductions_json: JSON.stringify(deductions({ phone: 30, speeding: 10 })) })],
      days: [['2026-01-05', { day: '2026-01-05', safeDay: true }]],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Safe day on track')).toBeOnTheScreen();
    expect(screen.getByText('Confirmed when the day closes.')).toBeOnTheScreen();
    expect(screen.queryByTestId('stamp-safe-day')).toBeNull();
  });

  test('an upload the server refused is explained in words, with the code under Details', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, sync_state: 'failed', sync_error: 'trip_too_old' })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText("This drive didn't upload. It still counts here.")).toBeOnTheScreen();
    expect(screen.queryByText('Server code: trip_too_old')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Server code: trip_too_old')).toBeOnTheScreen();
    // The score the device computed still stands on the card.
    expect(screen.getByRole('image', { name: 'Score 90, Excellent, provisional' })).toBeOnTheScreen();
  });

  test('a drive crash recovery saved is labelled, and says what that means', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID, incomplete: 1 })] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByLabelText('Recovered')).toBeOnTheScreen();
    expect(screen.getByText(/saved from its last checkpoint/)).toBeOnTheScreen();
  });

  test('the footer links name the rest of the trip; sharing waits until the drive is confirmed', async () => {
    const w = await world({ trips: [scored] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    await screen.findByText('Near Home → Near Lincoln HS');
    await fireEvent.press(screen.getByRole('button', { name: 'See full trip' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/trips/[clientTripId]',
      params: { clientTripId: ID },
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Something wrong?' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/trips/[clientTripId]/events',
      params: { clientTripId: ID },
    });
    // Not synced yet: nothing true to share, and it says when there will be.
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    expect(screen.getByText("You can share a drive once RoadWise has its final score.")).toBeOnTheScreen();
    expect(screen.queryByText('Share cards are coming soon.')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/home');
  });
});

describe('sharing (D1 → F9)', () => {
  test('a synced final drive opens the share composer for this drive', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID, score: 88, status: 'final', sync_state: 'synced' })] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    const share = await screen.findByRole('button', { name: 'Share' });
    expect(share).toBeEnabled();
    expect(screen.queryByText("You can share a drive once RoadWise has its final score.")).toBeNull();
    await fireEvent.press(share);
    expect(mockRouter.push).toHaveBeenLastCalledWith('/rewards/share?kind=trip&clientTripId=trip-1');
  });

  test.each([
    ['synced but provisional', { status: 'provisional', sync_state: 'synced' }],
    ['final but queued', { status: 'final', sync_state: 'queued' }],
    ['final but refused', { status: 'final', sync_state: 'failed' }],
  ] as const)('%s: disabled, with the reason', async (_name, over) => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID, score: 88, ...over })] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    const share = await screen.findByRole('button', { name: 'Share' });
    expect(share).toBeDisabled();
    expect(screen.getByText("You can share a drive once RoadWise has its final score.")).toBeOnTheScreen();
    await fireEvent.press(share);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe('what the day earned (D1 item 5, M5)', () => {
  const synced = tripRow({ client_trip_id: ID, score: 90, status: 'final', sync_state: 'synced' });

  test("a confirmed safe day: the stamp, the day's points said to be the day's, and the streak after it", async () => {
    serveRewards(settledDay());
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(
      await screen.findByLabelText('Safe day, 75 points for the day. Streak after this day: 5')
    ).toBeOnTheScreen();
    expect(screen.getByText('Safe day · +75 points')).toBeOnTheScreen();
    expect(screen.getByText('Streak after this day: 5')).toBeOnTheScreen();
    expect(screen.getByText('Points are for the whole day, not just this drive.')).toBeOnTheScreen();
    expect(screen.getByTestId('stamp-safe-day', { includeHiddenElements: true })).toBeOnTheScreen();
    // A confirmed day is never "on track", and never waits for the day to close.
    expect(screen.queryByText('Confirmed when the day closes.')).toBeNull();
    expect(screen.queryByText('Safe day on track')).toBeNull();
  });

  test('a confirmed good day has no stamp', async () => {
    serveRewards(settledDay({ tier: 'good', points: 20, phone_free: false, streak_after: 2 }));
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Good day · +20 points')).toBeOnTheScreen();
    expect(screen.queryByTestId('stamp-safe-day', { includeHiddenElements: true })).toBeNull();
  });

  test('a confirmed day that earned nothing says so plainly: no streak, no tip upsell, no settle rule', async () => {
    serveRewards(
      settledDay({ tier: 'none', outcome: 'unsafe', outcome_reason: 'unsafe', points: 0, phone_free: false, streak_after: 0 })
    );
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('No points for this day')).toBeOnTheScreen();
    expect(screen.getByTestId('earned')).not.toHaveTextContent(/Streak|Confirmed when|tip|practi/i);
  });

  test('a day from before the rewards says why, never "Confirmed when the day closes"', async () => {
    serveRewards(beforeRewardsDay());
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText("This day isn't part of your rewards.")).toBeOnTheScreen();
    expect(screen.getByText('Rewards count from February 1, 2026.')).toBeOnTheScreen();
    expect(screen.queryByText('Confirmed when the day closes.')).toBeNull();
  });

  test('a day the settlement passed without a row is not counted either', async () => {
    serveRewards({ ...settledDay(), days: [] });
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(
      await screen.findByText('A drive on this day reached RoadWise after the day was confirmed, so the day stays as it was.')
    ).toBeOnTheScreen();
    expect(screen.queryByText('Confirmed when the day closes.')).toBeNull();
  });

  test("a late day frozen by the settlement reads as not counted, never 'settled, no points'", async () => {
    serveRewards(settledDay({ outcome: 'neutral', outcome_reason: 'late', tier: 'none', points: 0, phone_free: false, streak_after: 4 }));
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(
      await screen.findByText('A drive on this day reached RoadWise after the day was confirmed, so the day stays as it was.')
    ).toBeOnTheScreen();
    expect(screen.queryByText('No points for this day')).toBeNull();
  });

  test('offline with nothing saved: unknown is said as unknown, never guessed', async () => {
    const double = serveRewards(pendingDay());
    double.server.fail.fetch = new RewardsOfflineError();
    const w = await world({ trips: [synced] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText("Couldn't check this day's points right now.")).toBeOnTheScreen();
    expect(screen.queryByText('Confirmed when the day closes.')).toBeNull();
    expect(screen.queryByText('Safe day on track')).toBeNull();
  });

  test('every new Earned and share line passes BANNED_COPY', () => {
    const lines = [
      'Safe day · +75 points',
      'Safe day, 75 points for the day',
      'Streak after this day: 5',
      'Points are for the whole day, not just this drive.',
      'No points for this day',
      "You can share a drive once RoadWise has its final score.",
      "Couldn't check this day's points right now.",
    ];
    for (const line of lines) for (const banned of BANNED_COPY) expect(line).not.toMatch(banned);
  });
});

describe('a clean drive', () => {
  const perfect = tripRow({ client_trip_id: ID, score: 100, status: 'final', sync_state: 'synced' });

  test('is stamped CLEAN DRIVE — held still under reduce motion — with the keep-it-up card', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const w = await world({ trips: [perfect] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);

    const stamp = await screen.findByLabelText('Clean drive');
    await waitFor(() => expect(stamp).toHaveStyle({ transform: [{ rotate: '-8deg' }] }));
    expect(screen.getByRole('image', { name: 'Score 100, Excellent' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Tip: Keep the run going' })).toBeOnTheScreen();
    // Three positives, no cost row.
    expect(screen.getByLabelText('No phone use')).toBeOnTheScreen();
    expect(screen.getByLabelText('Kept to the limit')).toBeOnTheScreen();
    expect(screen.getByLabelText('Smooth braking')).toBeOnTheScreen();
    expect(screen.queryByText(/episode/)).toBeNull();
  });

  test('with motion allowed the stamp still lands, and the ring draws in', async () => {
    const w = await world({ trips: [perfect] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByLabelText('Clean drive')).toBeOnTheScreen();
    // The drawing sits behind the ring's spoken label, hidden from assistive technology.
    expect(screen.getByTestId('score-ring-arc', { includeHiddenElements: true })).toBeOnTheScreen();
  });
});

describe('a drive without a score', () => {
  test('shows the facts and why: too short', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: null, status: 'unscored', distance_m: 300, duration_s: 60 })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Not scored')).toBeOnTheScreen();
    expect(screen.getByText(/Too short to score fairly/)).toBeOnTheScreen();
    expect(screen.getByText('1 min')).toBeOnTheScreen();
    expect(screen.queryByTestId('highlights')).toBeNull();
    expect(screen.queryByTestId('tip-card')).toBeNull();
    expect(screen.queryByTestId('earned')).toBeNull();
  });

  test('weak GPS uses the spec words and carries the grade', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: null, status: 'unscored', data_quality: 'C' })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('GPS signal was too weak to score this trip fairly.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Data quality C, Weak GPS')).toBeOnTheScreen();
  });

  test('a passenger trip is stamped', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: null, status: 'unscored', role: 'passenger' })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByLabelText('Passenger')).toBeOnTheScreen();
    expect(screen.getByText("You weren't driving, so this drive isn't scored.")).toBeOnTheScreen();
  });

  test('a driver trip the row cannot explain is calculating while its upload is owed', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: null, status: 'unscored', sync_state: 'queued' })],
    });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Calculating…')).toBeOnTheScreen();
    expect(screen.getByText('Your score arrives when this drive syncs.')).toBeOnTheScreen();
  });
});

describe('an unclassified drive', () => {
  const unknown = tripRow({ client_trip_id: ID, score: null, status: 'unscored', role: 'unknown' });

  test('asks who was driving, in the spec words, and answers Passenger on the spot', async () => {
    const w = await world({ trips: [unknown] }, () => NOW);
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    expect(await screen.findByText('Who was driving?')).toBeOnTheScreen();
    expect(screen.getByText('Were you driving?')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Yes, I drove' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Bus, train, other' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Passenger' }));

    // The screen refreshes to the passenger card, the row is written, the answer is queued.
    expect(await screen.findByLabelText('Passenger')).toBeOnTheScreen();
    expect(screen.queryByText('Were you driving?')).toBeNull();
    expect(await createTripsRepo(w.db).get(ID)).toMatchObject({ role: 'passenger', role_source: 'manual' });
    const [item] = await createQueueRepo(w.db).nextDue(Date.now() + 1, 10);
    expect(item).toMatchObject({ kind: 'set-role' });
    expect(JSON.parse(item?.payload_json ?? '{}')).toEqual({ action: 'set-role', clientTripId: ID, role: 'passenger' });
  });

  test('Yes, I drove leaves the score to the server and says so', async () => {
    const w = await world({ trips: [unknown] });
    await w.renderScreen(<TripSummaryScreen clientTripId={ID} />);
    await screen.findByText('Were you driving?');
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, I drove' }));
    expect(await screen.findByText('Calculating…')).toBeOnTheScreen();
  });
});
