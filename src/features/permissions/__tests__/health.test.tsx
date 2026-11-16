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
function deps(adapter: FakeAdapter, androidApi = 34): PermissionBoardDeps {
  return {
    adapter,
    appState: fakeAppState(),
    androidApi: adapter.current.platform === 'android' ? androidApi : null,
    watchDashcam: () => () => {},
    ensureChannels: async () => {},
    requestDeviceSync: () => {},
  };
}

async function open(adapter: FakeAdapter, opts: { settings?: Record<string, unknown>; androidApi?: number } = {}) {
  const w = await appWorld({ settings: opts.settings });
  await w.render(<PermissionsScreen deps={deps(adapter, opts.androidApi)} />);
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

it('iOS lists Location Always and Background App Refresh with the note about Always; Android without the drive detector lists neither', async () => {
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
  expect(screen.getByText("With Location set to Allow all the time, RoadWise notices drives and records them even when it's closed. Your location is never sold.")).toBeOnTheScreen();
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

describe('Android with the drive detector', () => {
  const android = (over: Parameters<typeof snap>[0] = {}) =>
    fakeAdapter(snap({ platform: 'android', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied', liveActivities: true, unusedAppPause: 'on', ...over }));

  it("lists Allow all the time, App battery usage and Pause app activity in Android's words", async () => {
    await open(android());
    expect(ids()).toEqual(['location', 'precise', 'locationAlways', 'motion', 'backgroundRefresh', 'unusedApps', 'notifications', 'bluetooth', 'camera']);
    expect(within(screen.getByTestId('permission-locationAlways')).getByText('Location all the time')).toBeOnTheScreen();
    expect(screen.getByTestId('permission-locationAlways-fix')).toHaveTextContent('Allow all the time');
    expect(within(screen.getByTestId('permission-backgroundRefresh')).getByText('App battery usage')).toBeOnTheScreen();
    expect(screen.getByTestId('permission-backgroundRefresh-status')).toHaveTextContent('Off');
    expect(screen.getByTestId('permission-backgroundRefresh-fix')).toHaveTextContent('Open Settings');
    expect(within(screen.getByTestId('permission-unusedApps')).getByText('Pause app activity if unused')).toBeOnTheScreen();
    expect(screen.getByTestId('permission-unusedApps-fix')).toHaveTextContent('Open Settings');
    // A battery left at Optimized (available) is fine; an unread unused-app switch is no row.
    clearQueryClients();
    await open(android({ backgroundRefresh: 'available', unusedAppPause: null }));
    expect(screen.getByTestId('permission-backgroundRefresh-status')).toHaveTextContent('On');
    expect(ids()).not.toContain('unusedApps');
  });

  it('Allow all the time shows the disclosure first: Not now asks nothing, Continue asks once', async () => {
    const adapter = android();
    await open(adapter);
    await tap('permission-locationAlways-fix');
    expect(await screen.findByTestId('background-disclosure-body')).toHaveTextContent(/even when the app is closed or not in use/);
    expect(adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual([]);
    await tap('background-disclosure-not-now');
    await waitFor(() => expect(screen.queryByTestId('background-disclosure-body')).toBeNull());
    expect(adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual([]);
    await tap('permission-locationAlways-fix');
    await tap('background-disclosure-continue');
    await waitFor(() => expect(screen.getByTestId('permission-locationAlways-status')).toHaveTextContent('On'));
    expect(adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual(['requestLocationAlways:disclosed']);
  });

  it('a request with no effect sends the next tap to Settings, still after the disclosure', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'foreground', canAskAlways: false, backgroundRefresh: 'available' }), { always: 'whenInUse' });
    await open(adapter);
    await tap('permission-locationAlways-fix');
    await tap('background-disclosure-continue');
    await waitFor(() => expect(screen.getByTestId('permission-locationAlways-fix')).toHaveTextContent('Open Settings'));
    await tap('permission-locationAlways-fix');
    expect(await screen.findByTestId('background-disclosure-body')).toBeOnTheScreen();
    expect(adapter.log).not.toContain('openAppSettings');
    await tap('background-disclosure-continue');
    await waitFor(() => expect(adapter.log).toContain('openAppSettings'));
  });

  it("Pause app activity if unused reads Android's own switch: On while Android may pause RoadWise, Off once it is turned off", async () => {
    await open(android({ unusedAppPause: 'on' }));
    expect(screen.getByTestId('permission-unusedApps-status')).toHaveTextContent('On');
    expect(screen.getByTestId('permission-unusedApps-detail')).toHaveTextContent("If RoadWise goes unopened for a few months, Android may pause it and drives won't start.");
    expect(screen.getByLabelText(/^Pause app activity if unused: on\./)).toBeOnTheScreen();
    clearQueryClients();
    await open(android({ unusedAppPause: 'off', backgroundRefresh: 'available' }));
    expect(screen.getByTestId('permission-unusedApps-status')).toHaveTextContent('Off');
    expect(screen.getByLabelText(/^Pause app activity if unused: off\./)).toBeOnTheScreen();
    expect(screen.queryByTestId('permission-unusedApps-fix')).toBeNull();
  });

  it('Android 11 names its own switch and says it takes the permissions back', async () => {
    await open(android({ unusedAppPause: 'on' }), { androidApi: 30 });
    expect(within(screen.getByTestId('permission-unusedApps')).getByText("Remove permissions if app isn't used")).toBeOnTheScreen();
    expect(screen.getByTestId('permission-unusedApps-status')).toHaveTextContent('On');
    expect(screen.getByTestId('permission-unusedApps-detail')).toHaveTextContent("If RoadWise goes unopened for months, Android may remove its permissions and drives won't start.");
  });

  it('Battery Saver limiting location needs a look, and its fix opens the Battery Saver page', async () => {
    const adapter = android({ backgroundRefresh: 'restricted', unusedAppPause: 'off' });
    await open(adapter);
    expect(screen.getByTestId('permission-backgroundRefresh-status')).toHaveTextContent('Needs a look');
    expect(screen.getByTestId('permission-backgroundRefresh-detail')).toHaveTextContent('Battery Saver is limiting location, so drives may be missed or cut short.');
    expect(screen.getByTestId('permissions-summary')).toHaveTextContent('A few things need a look');
    await tap('permission-backgroundRefresh-fix');
    await waitFor(() => expect(adapter.log).toContain('openBatterySaverSettings'));
    expect(adapter.log).not.toContain('openAppSettings');
  });

  it('Android 9 and lower: the location fix shows the disclosure first (allowing location allows it in the background too)', async () => {
    const adapter = fakeAdapter(
      snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false, backgroundRefresh: 'available' }),
      { foreground: 'always' }
    );
    await open(adapter, { androidApi: 28 });
    await tap('permission-location-fix');
    expect(await screen.findByTestId('background-disclosure-next')).toHaveTextContent('Next, choose "Allow".');
    expect(adapter.log.filter((c) => c.startsWith('request'))).toEqual([]);
    await tap('background-disclosure-not-now');
    await waitFor(() => expect(screen.queryByTestId('background-disclosure-body')).toBeNull());
    expect(adapter.log.filter((c) => c.startsWith('request'))).toEqual([]);
    await tap('permission-location-fix');
    await tap('background-disclosure-continue');
    await waitFor(() => expect(screen.getByTestId('permission-location-status')).toHaveTextContent('On'));
    expect(adapter.log.filter((c) => c.startsWith('request'))).toEqual(['requestLocationForeground']);
  });

  it('with Automatic drives switched off, its three rows read Not in use', async () => {
    mockAuto = { state: 'disabled' };
    await open(android({ location: 'foreground' }));
    for (const id of ['locationAlways', 'backgroundRefresh', 'unusedApps']) {
      expect(screen.getByTestId(`permission-${id}-status`)).toHaveTextContent('Not in use');
    }
    expect(screen.getByTestId('permissions-summary')).toHaveTextContent('Everything RoadWise needs is on');
  });
});
