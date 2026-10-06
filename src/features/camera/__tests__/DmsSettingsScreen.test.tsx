// `/settings/dms`: the permission is asked only when turning DMS on; the setup is required when never calibrated;
// off is local and immediate; nothing changes during a drive.
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

import { dmsCopy } from '../copy';
import { DMS_CALIBRATED_KEY, DMS_ENABLED_KEY } from '../dmsSettings';
import { DmsSettingsScreen } from '../DmsSettingsScreen';
import { DMS_SETUP_HREF } from '../routes';

const mockRouter = routerDouble();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useRouter: () => mockRouter, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
const mockDrive = { status: 'idle' };
jest.mock('@/drive/useDrive', () => ({ useDrive: (select: (s: { status: string }) => unknown) => select({ status: mockDrive.status }) }));
jest.mock('@/drive/policy', () => ({ isBusyStatus: (s: string) => s !== 'idle' }));
jest.mock('react-native/Libraries/Linking/Linking', () => ({ openSettings: jest.fn(async () => {}), openURL: jest.fn(), canOpenURL: jest.fn(async () => true), addEventListener: jest.fn(() => ({ remove() {} })) }));

const copy = dmsCopy.settings;

afterEach(() => {
  clearQueryClients();
  mockDrive.status = 'idle';
  mockRouter.push.mockClear();
});

async function renderScreen(seed: Record<string, unknown> = {}, permission: 'granted' | 'denied' | 'unavailable' = 'granted') {
  const w = await world();
  const settings = createSettingsRepo(w.db);
  for (const [k, v] of Object.entries(seed)) await settings.set(k, v);
  const requestPermission = jest.fn(async () => permission);
  await w.renderScreen(<DmsSettingsScreen deps={{ requestPermission }} />);
  await waitFor(() => expect(screen.queryByTestId('dms-loading')).toBeNull());
  return { ...w, settings, requestPermission };
}

const flip = async (on: boolean) => {
  await act(async () => {
    fireEvent(screen.getByTestId('dms-switch'), 'valueChange', on);
  });
};

test('off by default, uncalibrated: the privacy note and the beta label are shown; turning on asks for the camera, then opens the setup (nothing written yet)', async () => {
  const { settings, requestPermission } = await renderScreen();
  expect(screen.getByTestId('dms-switch')).toHaveProp('value', false);
  expect(screen.getByTestId('dms-privacy')).toHaveTextContent(copy.privacy);
  expect(screen.getByText(copy.beta)).toBeOnTheScreen();
  expect(screen.getByTestId('dms-calibrated')).toHaveTextContent(copy.notCalibrated);
  expect(screen.getByText(copy.calibrate)).toBeOnTheScreen();
  await flip(true);
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(DMS_SETUP_HREF));
  expect(requestPermission).toHaveBeenCalledTimes(1);
  await expect(settings.get(DMS_ENABLED_KEY)).resolves.toBeNull();
});

test('calibrated: turning on asks for the camera and writes dms.enabled; off is written at once without asking', async () => {
  const { settings, requestPermission } = await renderScreen({ [DMS_CALIBRATED_KEY]: Date.UTC(2026, 9, 5) });
  expect(screen.getByTestId('dms-calibrated')).toHaveTextContent(/Calibrated/);
  expect(screen.getByText(copy.recalibrate)).toBeOnTheScreen();
  await flip(true);
  await waitFor(() => expect(screen.getByTestId('dms-switch')).toHaveProp('value', true));
  await waitFor(async () => expect(await settings.get(DMS_ENABLED_KEY)).toBe(true));
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(mockRouter.push).not.toHaveBeenCalled();
  await flip(false);
  await waitFor(async () => expect(await settings.get(DMS_ENABLED_KEY)).toBe(false));
  expect(requestPermission).toHaveBeenCalledTimes(1);
});

test('the camera permission refused: a banner with Open Settings, DMS stays off, no setup', async () => {
  const { settings } = await renderScreen({ [DMS_CALIBRATED_KEY]: Date.UTC(2026, 9, 5) }, 'denied');
  await flip(true);
  expect(await screen.findByTestId('dms-permission')).toBeOnTheScreen();
  expect(screen.getByText(copy.permissionDenied)).toBeOnTheScreen();
  expect(screen.getByText(copy.openSettings)).toBeOnTheScreen();
  expect(screen.getByTestId('dms-switch')).toHaveProp('value', false);
  await expect(settings.get(DMS_ENABLED_KEY)).resolves.toBeNull();
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('signed out or busy elsewhere (unavailable): a plain notice, nothing written', async () => {
  const { settings } = await renderScreen({}, 'unavailable');
  await flip(true);
  expect(await screen.findByTestId('dms-unavailable')).toBeOnTheScreen();
  expect(screen.getByText(copy.unavailable)).toBeOnTheScreen();
  await expect(settings.get(DMS_ENABLED_KEY)).resolves.toBeNull();
});

test('during a drive: the banner says so and the switch is disabled; the calibration button too', async () => {
  mockDrive.status = 'recording';
  const { requestPermission } = await renderScreen({ [DMS_CALIBRATED_KEY]: 1 });
  expect(screen.getByTestId('dms-busy')).toBeOnTheScreen();
  expect(screen.getByText(copy.duringDrive)).toBeOnTheScreen();
  await flip(true);
  expect(requestPermission).not.toHaveBeenCalled();
  expect(screen.getByTestId('dms-switch')).toHaveProp('value', false);
});

test('the calibration button opens the setup', async () => {
  await renderScreen();
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-calibrate'));
  });
  expect(mockRouter.push).toHaveBeenCalledWith(DMS_SETUP_HREF);
});
