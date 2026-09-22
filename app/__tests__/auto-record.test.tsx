/**
 * Task 19: `/permissions/auto-record`, the post-onboarding place to turn auto-record on or off
 * (it replaced M3's interim detection screen). A9's panel; a Fix for what blocks it; and an Always
 * grant this account has not affirmed the disclosure for goes through the disclosure first (T9
 * security: Always is device-level and survives a handover, a consent record does not). Since
 * round 1 that gate is the shared model's, so it opens in place here as in onboarding.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { DISCLOSURE_AFFIRMED_KEY } from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  drive,
  fakeAdapter,
  fakeAppState,
  fakeHost,
  noRefresh,
  permissionsWorld,
  snap,
  type FakeAdapter,
  type Seed,
} from '@/features/permissions/__fixtures__/harness';
import { recordConsent } from '@/data/supabase/profile';
import { REPAIR_HREF } from '@/features/permissions/PermissionHealthScreen';
import { clearQueryClients, routerDouble } from '@/features/trips/__fixtures__/render';

import { AutoRecordScreen } from '../(app)/permissions/auto-record';

const mockRouter = routerDouble();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } }),
}));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

const AFFIRMED = { [DISCLOSURE_AFFIRMED_KEY]: { version: 'pd-1', at: T0, uid: 'u1' } };

afterEach(() => {
  clearQueryClients();
  jest.clearAllMocks();
});

async function renderScreen(adapter: FakeAdapter, opts: { seed?: Seed; intent?: boolean } = {}) {
  const w = await permissionsWorld(opts.seed ?? { trips: [drive(1)] });
  const fh = fakeHost({ intent: opts.intent });
  await w.render(
    <AutoRecordScreen
      deps={{ adapter, appState: fakeAppState(), now: () => T0, manufacturer: null, appConfig: { refresher: noRefresh } }}
    />,
    fh.host
  );
  await waitFor(() => expect(screen.getByTestId('auto-record-line')).toBeOnTheScreen());
  return { ...w, host: fh.host };
}

const toggle = (on: boolean) =>
  act(async () => {
    fireEvent(screen.getByTestId('auto-record-toggle'), 'valueChange', on);
  });

test('Always granted, but this account never affirmed the disclosure: turning on opens it in place', async () => {
  const { host } = await renderScreen(fakeAdapter(snap()));
  await toggle(true);
  expect(await screen.findByTestId('background-disclosure-repair')).toBeOnTheScreen();
  expect(host.setAutoDetect).not.toHaveBeenCalled();
  // Continue records this account's consent, then turns auto-record on.
  await act(async () => {
    fireEvent.press(await screen.findByTestId('disclosure-continue'));
  });
  await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
  expect(recordConsent).toHaveBeenCalledWith('u1', { type: 'background_location', version: 'pd-1' });
});

test('a disclosure affirmed below the arming minimum does not count', async () => {
  const { host } = await renderScreen(fakeAdapter(snap()), {
    seed: { trips: [drive(1)], settings: { [DISCLOSURE_AFFIRMED_KEY]: { version: 'pd-0', at: T0, uid: 'u1' } } },
  });
  await toggle(true);
  expect(await screen.findByTestId('background-disclosure-repair')).toBeOnTheScreen();
  expect(host.setAutoDetect).not.toHaveBeenCalled();
});

test('affirmed by this account: turning on goes straight through the drive host', async () => {
  const { host } = await renderScreen(fakeAdapter(snap()), { seed: { trips: [drive(1)], settings: AFFIRMED } });
  await toggle(true);
  expect(host.setAutoDetect).toHaveBeenCalledWith(true);
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('turning off never needs the disclosure', async () => {
  const { host } = await renderScreen(fakeAdapter(snap()), { intent: true });
  await toggle(false);
  expect(host.setAutoDetect).toHaveBeenCalledWith(false);
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('Always missing: the Fix opens the disclosure, and nothing asks the OS from here', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  await renderScreen(adapter);
  expect(screen.getByTestId('auto-record-toggle').props.disabled).toBe(true);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Allow all the time' }));
  });
  expect(mockRouter.push).toHaveBeenCalledWith(REPAIR_HREF);
  expect(adapter.log.filter((c) => c.startsWith('request'))).toEqual([]);
});

test('motion missing: the Fix opens permission health', async () => {
  await renderScreen(fakeAdapter(snap({ motion: 'denied' })));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Fix in Permissions' }));
  });
  expect(mockRouter.push).toHaveBeenCalledWith('/permissions');
});

test('nothing blocks: no Fix button', async () => {
  await renderScreen(fakeAdapter(snap()), { seed: { trips: [drive(1)], settings: AFFIRMED } });
  expect(screen.queryByTestId('auto-record-fix-always')).toBeNull();
  expect(screen.queryByTestId('auto-record-fix-permissions')).toBeNull();
});

test('final review I3: with auto-record withdrawn it says so, as Home does, and offers no Fix or disclosure', async () => {
  await renderScreen(fakeAdapter(snap({ location: 'foreground' })), {
    seed: { trips: [drive(1)], autoDetect: false },
    intent: true,
  });
  expect(screen.getByTestId('auto-record-line')).toHaveTextContent(/isn’t available yet/);
  expect(screen.getByTestId('auto-record-toggle').props.disabled).toBe(true);
  expect(screen.queryByTestId('auto-record-fix-always')).toBeNull();
  expect(screen.queryByTestId('auto-record-fix-permissions')).toBeNull();
});
