import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

import { DRIVER_SIDE_KEY } from '../bridge';
import { CameraSettingsScreen } from '../CameraSettingsScreen';
import { cameraConsent, cameraCopy } from '../copy';
import { CAMERA_CONSENT_VERSION, readCameraOptIn } from '../optIn';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockSession = { session: { user: { id: 'u1' } }, profile: { age_band: '18_plus' as string } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));

afterEach(() => {
  clearQueryClients();
  mockSession.profile.age_band = '18_plus';
});

const copy = cameraCopy.settings;

async function renderScreen(flag = true) {
  const w = await world();
  const record = jest.fn(async () => ({}));
  await w.renderScreen(<CameraSettingsScreen deps={{ readCameraBeta: async () => flag, recordConsent: record }} />);
  return { ...w, record, settings: createSettingsRepo(w.db) };
}

test('off by default; on records the consent and shows the seat; off again is local and immediate', async () => {
  const { record, settings } = await renderScreen();
  expect(await screen.findByText(copy.offNote)).toBeOnTheScreen();
  expect(screen.getByText(cameraConsent.lead)).toBeOnTheScreen();
  expect(screen.getByTestId('camera-switch')).toHaveProp('value', false);
  await act(async () => {
    fireEvent(screen.getByTestId('camera-switch'), 'valueChange', true);
  });
  await waitFor(() => expect(screen.getByTestId('camera-switch')).toHaveProp('value', true));
  expect(record).toHaveBeenCalledWith('u1', { type: 'camera', version: CAMERA_CONSENT_VERSION });
  await expect(readCameraOptIn(settings, 'u1')).resolves.toBe(true);
  expect(screen.getByTestId('camera-state')).toHaveTextContent(`${copy.onNote} ${copy.permissionNote}`);

  await act(async () => {
    fireEvent.press(screen.getByTestId('camera-seat-right'));
  });
  await waitFor(async () => expect(await settings.get(DRIVER_SIDE_KEY)).toBe('right'));

  await act(async () => {
    fireEvent(screen.getByTestId('camera-switch'), 'valueChange', false);
  });
  await waitFor(() => expect(screen.getByTestId('camera-switch')).toHaveProp('value', false));
  await expect(readCameraOptIn(settings, 'u1')).resolves.toBe(false);
  expect(record).toHaveBeenCalledTimes(1);
});

test('a minor, or the flag off: why, and no switch', async () => {
  mockSession.profile.age_band = '13_17';
  await renderScreen();
  expect(await screen.findByText(cameraCopy.step.notAvailableAge)).toBeOnTheScreen();
  expect(screen.queryByTestId('camera-switch')).toBeNull();
  clearQueryClients();
  mockSession.profile.age_band = '18_plus';
  await renderScreen(false);
  expect(await screen.findByText(cameraCopy.step.notAvailableFlag)).toBeOnTheScreen();
  expect(screen.queryByTestId('camera-switch')).toBeNull();
});
