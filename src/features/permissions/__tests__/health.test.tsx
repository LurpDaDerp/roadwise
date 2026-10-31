/**
 * Settings › Permissions: every permission of this phone from the board, its fix (one OS call on
 * the tap, then the phone read again; Settings where it can't ask), Show on Home for a hidden row,
 * and the summary.
 */
import { screen, waitFor, within } from '@testing-library/react-native';

import { HOME_HIDDEN_KEY } from '@/core/permissions';
import type { AutoDrives } from '@/features/autoDrives/useAutoDrives';
import { PAIRED_KEY } from '@/dashcam/keys';

import { appWorld, clearQueryClients, fakeAdapter, fakeAppState, snap, tap, type FakeAdapter } from '../__fixtures__/harness';
import { PermissionsScreen } from '../PermissionsScreen';
import type { PermissionBoardDeps } from '../usePermissionBoard';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'u1' } } }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), canGoBack: () => true }) }));
let mockAuto: AutoDrives = { state: 'unsupported' };
jest.mock('@/features/autoDrives/useAutoDrives', () => ({ useAutoDrives: () => mockAuto }));

afterEach(() => {
  clearQueryClients();
  mockAuto = { state: 'unsupported' };
});

const PAIRED = { dashcamId: 'a1b2c3d4e5f6', peripheralId: 'AA:BB', name: 'DashPal-E5F6', pairedAt: 1, secure: true as const };
function deps(adapter: FakeAdapter): PermissionBoardDeps {
  return {
    adapter,
    appState: fakeAppState(),
    androidApi: adapter.current.platform === 'android' ? 34 : null,
    watchDashcam: () => () => {},
    ensureChannels: async () => {},
    requestDeviceSync: () => {},
  };
}

async function open(adapter: FakeAdapter, opts: { settings?: Record<string, unknown> } = {}) {
  const w = await appWorld({ settings: opts.settings });
  await w.render(<PermissionsScreen deps={deps(adapter)} />);
  await screen.findByTestId('permissions-summary');
  return w;
}

const ids = () => screen.queryAllByTestId(/^permission-[a-zA-Z]+$/).map((n) => String(n.props.testID).replace('permission-', ''));

it('a Fix asks the OS once (While Using, never Always) and reads the phone again', async () => {
  const adapter = fakeAdapter(snap({ location: 'undetermined', precise: null }));
  await open(adapter);
  expect(screen.getByTestId('permission-location-fix')).toHaveTextContent('Allow location');
  await tap('permission-location-fix');
  await waitFor(() => expect(screen.getByTestId('permission-location-status')).toHaveTextContent('On'));
  expect(adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual(['requestLocationForeground']);
});

it('a row turned off for good opens Settings, stamping the "back from Settings" mark', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'denied' }));
  const w = await open(adapter);
  expect(screen.getByTestId('permission-motion-fix')).toHaveTextContent('Open Settings');
  await tap('permission-motion-fix');
  await waitFor(() => expect(adapter.log).toContain('openAppSettings'));
  expect(await w.settings.get('permissions.settingsReturnAck')).not.toBeNull();
});

it('an unreadable phone says so with a retry', async () => {
  const adapter = fakeAdapter(snap());
  adapter.failReads = true;
  const w = await appWorld();
  await w.render(<PermissionsScreen deps={deps(adapter)} />);
  expect(await screen.findByTestId('permissions-read-error')).toBeOnTheScreen();
});

it('iOS lists Location Always and Background App Refresh with the note about Always; Android lists neither', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied' }));
  await open(adapter);
  expect(ids()).toEqual(['location', 'precise', 'locationAlways', 'motion', 'backgroundRefresh', 'notifications', 'bluetooth', 'camera']);
  expect(screen.getByTestId('permission-locationAlways-status')).toHaveTextContent('Needs a look');
  expect(screen.getByTestId('permission-backgroundRefresh-status')).toHaveTextContent('Off');
  expect(screen.getByTestId('permission-backgroundRefresh-fix')).toHaveTextContent('Open Settings');
  expect(screen.getByText(/With Location set to Always, RoadWise notices drives/)).toBeOnTheScreen();
  expect(screen.getByTestId('permission-locationAlways-fix')).toHaveTextContent('Allow Always');
  await tap('permission-locationAlways-fix');
  await waitFor(() => expect(screen.getByTestId('permission-locationAlways-status')).toHaveTextContent('On'));
  expect(adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual(['requestLocationAlways']);
  clearQueryClients();
  await open(fakeAdapter(snap({ platform: 'android' })));
  expect(ids()).toEqual(['location', 'precise', 'motion', 'notifications', 'bluetooth', 'camera']);
  expect(screen.getByText('A drive uses location only while it records. Start each drive from Home.')).toBeOnTheScreen();
  // On both phones, the note on phone pickups.
  expect(
    within(screen.getByTestId('permissions-phone-note')).getByText(
      'On a drive, RoadWise can tell from motion alone when you pick up your phone. It never sees your screen, apps or messages.'
    )
  ).toBeOnTheScreen();
});

it('with Automatic drives switched off, Location Always and Background App Refresh read Not in use and leave the summary', async () => {
  const ios = () => fakeAdapter(snap({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied' }));
  mockAuto = { state: 'off', missing: ['locationAlways', 'backgroundRefresh'] };
  await open(ios());
  expect(screen.getByTestId('permissions-summary')).toHaveTextContent('A few things need a look');
  expect(screen.getByTestId('permission-locationAlways-status')).toHaveTextContent('Needs a look');
  clearQueryClients();
  mockAuto = { state: 'disabled' };
  await open(ios());
  expect(screen.getByTestId('permissions-summary')).toHaveTextContent('Everything RoadWise needs is on');
  for (const id of ['locationAlways', 'backgroundRefresh']) {
    expect(screen.getByTestId(`permission-${id}-status`)).toHaveTextContent('Not in use');
    expect(screen.getByTestId(`permission-${id}-detail`)).toHaveTextContent('Only needed for automatic drives, and those are turned off.');
  }
  // The driver can still grant it.
  expect(screen.getByTestId('permission-locationAlways-fix')).toHaveTextContent('Allow Always');
});

it('Bluetooth: Not in use without a pairing; Off with a pairing and the permission gone, fixed only in Settings', async () => {
  await open(fakeAdapter(snap({ platform: 'android' })));
  expect(screen.getByTestId('permission-bluetooth-status')).toHaveTextContent('Not in use');
  expect(screen.queryByTestId('permission-bluetooth-fix')).toBeNull();
  clearQueryClients();
  const adapter = fakeAdapter(snap({ platform: 'android' }));
  adapter.btPermission = 'undetermined';
  await open(adapter, { settings: { [PAIRED_KEY]: PAIRED } });
  expect(screen.getByTestId('permission-bluetooth-status')).toHaveTextContent('Off');
  expect(screen.getByTestId('permission-bluetooth')).toBeOnTheScreen();
  expect(screen.getByTestId('permission-bluetooth-fix')).toHaveTextContent('Open Settings');
  await tap('permission-bluetooth-fix');
  await waitFor(() => expect(adapter.log).toContain('openAppSettings'));
  expect(adapter.log).not.toContain('requestBluetooth');
});

it('the camera: Not in use until a scanner asks, On, or Off with Open Settings (never a request)', async () => {
  const adapter = fakeAdapter(snap());
  await open(adapter);
  expect(screen.getByTestId('permission-camera-status')).toHaveTextContent('Not in use');
  clearQueryClients();
  const on = fakeAdapter(snap());
  on.cam = { access: 'granted', canAskAgain: true };
  await open(on);
  expect(screen.getByTestId('permission-camera-status')).toHaveTextContent('On');
  clearQueryClients();
  const off = fakeAdapter(snap());
  off.cam = { access: 'denied', canAskAgain: true };
  await open(off);
  expect(screen.getByTestId('permission-camera-status')).toHaveTextContent('Off');
  expect(screen.getByTestId('permission-camera-fix')).toHaveTextContent('Open Settings');
});

it('Hidden from Home with Show on Home only on a hidden row that is missing; Show on Home removes it', async () => {
  const adapter = fakeAdapter(snap({ motion: 'denied', notifications: 'granted' }));
  const w = await open(adapter, { settings: { [HOME_HIDDEN_KEY]: ['motion', 'notifications'] } });
  expect(screen.getByTestId('permission-motion-hidden')).toHaveTextContent('Hidden from Home');
  expect(screen.queryByTestId('permission-notifications-hidden')).toBeNull();
  expect(screen.queryByTestId('permission-notifications-show')).toBeNull();
  await tap('permission-motion-show');
  await waitFor(() => expect(screen.queryByTestId('permission-motion-hidden')).toBeNull());
  expect(await w.settings.get(HOME_HIDDEN_KEY)).toEqual(['notifications']);
});

it('the summary: ok with Not in use and Can\'t check rows; broken with Location Services or precise off; otherwise attention', async () => {
  await open(fakeAdapter(snap({ precise: null })));
  expect(screen.getByTestId('permissions-summary')).toHaveTextContent('Everything RoadWise needs is on');
  clearQueryClients();
  await open(fakeAdapter(snap({ platform: 'android', locationServices: false })));
  expect(screen.getByTestId('permissions-summary')).toHaveTextContent("RoadWise can't record drives right now");
  expect(screen.getByTestId('permission-location-fix')).toHaveTextContent('Turn on location');
  clearQueryClients();
  await open(fakeAdapter(snap({ precise: false })));
  expect(screen.getByTestId('permissions-summary')).toHaveTextContent("RoadWise can't record drives right now");
  clearQueryClients();
  await open(fakeAdapter(snap({ notifications: 'denied', notificationsCanAskAgain: false })));
  expect(screen.getByTestId('permissions-summary')).toHaveTextContent('A few things need a look');
});

it('a fix that fails says so', async () => {
  const adapter = fakeAdapter(snap({ motion: 'undetermined' }));
  (adapter.requestMotion as jest.Mock).mockRejectedValue(new Error('bridge'));
  await open(adapter);
  await tap('permission-motion-fix');
  expect(await screen.findByTestId('permissions-action-error')).toHaveTextContent("That didn't work. Try again.", { exact: false });
});
