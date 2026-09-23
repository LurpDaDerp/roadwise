/**
 * The delete sheet on the edit screen closes itself while the driving lockout is on (rev1: I12;
 * ruling U2 concern 5). It is an RN `Modal`, which renders natively above the lockout overlay, so
 * the overlay cannot cover it: the sheet has to go by itself, and come back only once the car has
 * stopped — never deleting anything on the way.
 */
import { act, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { createTripsRepo } from '@/data/db';
import { tripRow } from '@/data/queries/__fixtures__/rows';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { clearQueryClients, press, routerDouble, world } from '@/features/trips/__fixtures__/render';
import { EditTripScreen } from '@/features/trips/EditTripScreen';
import { pendingDay, serveRewards } from '@/features/trips/__fixtures__/rewards';

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

beforeEach(() => {
  serveRewards(pendingDay());
});

const ID = 'trip-1';
const T = 1_790_000_000_000;
const MPH = 0.44704;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'pocket',
    role: 'driver',
    clientTripId: 'live-trip',
    startedAt: T,
    lastRowTs: T,
    speedMps: 0,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: T,
    lockedOut: false,
    stoppedPanel: true,
    activeAlert: null,
    mutedForDrive: false,
    gps: 'good',
    thermal: 'nominal',
    callActive: false,
    screenLocked: false,
    lastFinalized: null,
    tripIndex: 5,
    dryRun: false,
    ...over,
  };
}

function fakeHost() {
  let current = state();
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    host: host as unknown as DriveHost,
    async push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      await act(async () => {
        for (const fn of listeners) fn(current);
      });
    },
  };
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});
afterEach(clearQueryClients);

test('the delete sheet closes at the lockout onset, deletes nothing, and is back at the next stop', async () => {
  const drive = fakeHost();
  const w = await world({ trips: [tripRow({ client_trip_id: ID })] });
  await w.renderScreen(
    <DriveProvider host={drive.host}>
      <EditTripScreen clientTripId={ID} />
    </DriveProvider>
  );
  await screen.findByTestId('edit-trip-screen');
  await press(screen.getByTestId('delete-trip'));
  expect(screen.getByTestId('delete-consequences')).toBeOnTheScreen();

  // Driving: the sheet is gone, hidden elements included, and so is its destructive button.
  await drive.push({ speedMps: 30 * MPH, lockedOut: true, stoppedPanel: false, stationarySinceTs: null });
  expect(screen.queryByTestId('delete-consequences', { includeHiddenElements: true })).toBeNull();
  expect(screen.queryByTestId('delete-confirm', { includeHiddenElements: true })).toBeNull();
  expect(await createTripsRepo(w.db).get(ID)).toMatchObject({ deleted_at: null });

  // Parked again: the sheet the driver opened is still theirs to finish or cancel.
  await drive.push({ speedMps: 0, lockedOut: false, stoppedPanel: true, stationarySinceTs: T + 60_000 });
  expect(screen.getByTestId('delete-consequences')).toBeOnTheScreen();
  expect(screen.getByTestId('delete-confirm')).toBeOnTheScreen();
  expect(await createTripsRepo(w.db).get(ID)).toMatchObject({ deleted_at: null });
});
