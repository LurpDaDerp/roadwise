import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { EVER_GRANTED_KEY, MANUAL_BY_CHOICE_KEY } from '@/core/permissions';
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
import { PERMISSIONS_HREF, PermissionHealthBanner } from '@/features/permissions/PermissionHealthBanner';
import { clearQueryClients, routerDouble } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockSession = {
  session: { user: { id: 'u1' } },
  profile: { driving_stage: 'new' } as { driving_stage: string } | null,
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

afterEach(() => {
  clearQueryClients();
  mockSession.profile = { driving_stage: 'new' };
  jest.clearAllMocks();
});

async function renderBanner(adapter: FakeAdapter, seed: Seed = { trips: [drive(1)] }, intent = true) {
  const w = await permissionsWorld(seed);
  const appState = fakeAppState();
  await w.render(
    <PermissionHealthBanner deps={{ adapter, appState, appConfig: { refresher: noRefresh } }} />,
    fakeHost({ intent }).host
  );
  // Settled: the phone has been read and the model has had its say.
  await waitFor(() => expect(adapter.log).toContain('snapshot'));
  await act(async () => {});
  return { ...w, appState };
}

const lapsedAlways = { [EVER_GRANTED_KEY]: { location: true, locationAlways: true, motion: true } };

test('location off: "Drive recording is off — tap to fix", and it opens B2', async () => {
  await renderBanner(fakeAdapter(snap({ location: 'denied', precise: null })));
  const banner = await screen.findByRole('button', { name: 'Drive recording is off — tap to fix' });
  expect(banner).toHaveProp('accessibilityHint', 'Opens permission health');
  fireEvent.press(banner);
  expect(mockRouter.push).toHaveBeenCalledWith(PERMISSIONS_HREF);
});

test('Always lost while auto-record is wanted: "Location access is limited — tap to fix"', async () => {
  await renderBanner(fakeAdapter(snap({ location: 'foreground' })), { trips: [drive(1)], settings: lapsedAlways });
  expect(await screen.findByRole('button', { name: 'Location access is limited — tap to fix' })).toBeOnTheScreen();
});

test('hidden for a driver in manual mode by choice', async () => {
  await renderBanner(fakeAdapter(snap({ location: 'foreground' })), {
    trips: [drive(1)],
    settings: { ...lapsedAlways, [MANUAL_BY_CHOICE_KEY]: true },
  });
  expect(screen.queryByTestId('banner-permission-health')).toBeNull();
});

test('hidden on iOS before the first drive', async () => {
  await renderBanner(fakeAdapter(snap({ platform: 'ios', location: 'foreground' })), {
    trips: [],
    settings: lapsedAlways,
  });
  expect(screen.queryByTestId('banner-permission-health')).toBeNull();
});

test('hidden while auto-record is withdrawn by the server', async () => {
  await renderBanner(fakeAdapter(snap({ location: 'foreground' })), {
    trips: [drive(1)],
    settings: lapsedAlways,
    autoDetect: false,
  });
  expect(screen.queryByTestId('banner-permission-health')).toBeNull();
});

test('motion lost for a manual driver: the manual-mode wording', async () => {
  await renderBanner(
    fakeAdapter(snap({ location: 'foreground', motion: 'denied' })),
    { trips: [drive(1)], settings: { ...lapsedAlways, [MANUAL_BY_CHOICE_KEY]: true } }
  );
  expect(
    await screen.findByRole('button', { name: 'Motion access is off, so drives may not end on their own — tap to fix' })
  ).toBeOnTheScreen();
});

test('hidden for a non-driver, when all is well, and while the phone cannot be read', async () => {
  mockSession.profile = { driving_stage: 'non_driver' };
  await renderBanner(fakeAdapter(snap({ location: 'denied', precise: null })));
  expect(screen.queryByTestId('banner-permission-health')).toBeNull();

  mockSession.profile = { driving_stage: 'new' };
  await renderBanner(fakeAdapter(snap()));
  expect(screen.queryByTestId('banner-permission-health')).toBeNull();

  const failing = fakeAdapter(snap({ location: 'denied', precise: null }));
  failing.failReads = true;
  await renderBanner(failing);
  expect(screen.queryByTestId('banner-permission-health')).toBeNull();
});

test('a return to the front re-reads the phone: a fix made in Settings clears the banner', async () => {
  const adapter = fakeAdapter(snap({ location: 'denied', precise: null }));
  const { appState } = await renderBanner(adapter);
  expect(await screen.findByTestId('banner-permission-health')).toBeOnTheScreen();
  adapter.current = snap();
  await act(async () => appState.foreground());
  await waitFor(() => expect(screen.queryByTestId('banner-permission-health')).toBeNull());
});
