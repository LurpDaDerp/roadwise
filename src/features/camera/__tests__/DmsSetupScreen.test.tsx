// `/settings/dms-setup`: intro → the live steps → done (calibratedAt stamped, DMS on) or a clear failure with a retry.
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { DmsSetupSession, DmsSetupView, SetupResult } from '@/core/dms';
import { initialSetup } from '@/core/dms';
import { createSettingsRepo } from '@/data/db/settings';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

import { dmsCopy } from '../copy';
import { DMS_CALIBRATED_KEY, DMS_ENABLED_KEY } from '../dmsSettings';
import { DmsSetupScreen } from '../DmsSetupScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockDrive = { status: 'idle' };
jest.mock('@/drive/useDrive', () => ({ useDrive: (select: (s: { status: string }) => unknown) => select({ status: mockDrive.status }) }));
jest.mock('@/drive/policy', () => ({ isBusyStatus: (s: string) => s !== 'idle' }));
jest.mock('react-native/Libraries/Linking/Linking', () => ({ openSettings: jest.fn(async () => {}), openURL: jest.fn(), canOpenURL: jest.fn(async () => true), addEventListener: jest.fn(() => ({ remove() {} })) }));
jest.mock('@/core/dms/host/preview', () => ({ previewView: () => null }));

const copy = dmsCopy.setup;

afterEach(() => {
  clearQueryClients();
  mockRouter.back.mockClear();
});

/** A scripted session: `run` emits the given views, then resolves with the result. */
function scripted(result: SetupResult, views: Partial<DmsSetupView>[] = []) {
  let onChange: ((v: DmsSetupView) => void) | null = null;
  let resolve: ((r: SetupResult) => void) | null = null;
  const session: DmsSetupSession & { cancelled: number } = {
    cancelled: 0,
    run: () =>
      new Promise<SetupResult>((res) => {
        resolve = res;
      }),
    cancel() {
      this.cancelled += 1;
    },
    setAppActive() {},
    view: () => ({ state: initialSetup(0), progress: 0, camera: 'off' }),
  };
  return {
    session,
    startSetup: async (cb: (v: DmsSetupView) => void) => {
      onChange = cb;
      return session;
    },
    emit(view: Partial<DmsSetupView>) {
      onChange?.({ state: initialSetup(0), progress: 0, camera: 'active', ...view } as DmsSetupView);
    },
    finish() {
      resolve?.(result);
    },
    views,
  };
}

async function renderScreen(startSetup: (cb: (v: DmsSetupView) => void) => Promise<DmsSetupSession | null>) {
  const w = await world();
  await w.renderScreen(<DmsSetupScreen deps={{ startSetup }} />);
  return { ...w, settings: createSettingsRepo(w.db) };
}

test('intro → start → the steps are shown with their copy and issues → done stamps the date and turns DMS on', async () => {
  const s = scripted({ ok: true, mirrors: 3, savedAtMs: 1_760_000_000_000 });
  const { settings } = await renderScreen(s.startSetup);
  expect(screen.getByTestId('dms-setup-intro')).toHaveTextContent(copy.intro);
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-start'));
  });
  await waitFor(() => expect(screen.getByTestId('dms-step-title')).toHaveTextContent(copy.stepTitle.mount));
  await act(async () => {
    s.emit({ state: { ...initialSetup(0), step: 'mount', issue: 'dark' }, progress: 0.1 });
  });
  expect(screen.getByTestId('dms-issue')).toBeOnTheScreen();
  expect(screen.getByText(copy.issue.dark)).toBeOnTheScreen();
  await act(async () => {
    s.emit({ state: { ...initialSetup(0), step: 'left_mirror' }, progress: 0.5 });
  });
  expect(screen.getByTestId('dms-step-title')).toHaveTextContent(copy.stepTitle.left_mirror);
  expect(screen.queryByTestId('dms-issue')).toBeNull();
  await act(async () => {
    s.finish();
  });
  expect(await screen.findByTestId('dms-setup-done')).toBeOnTheScreen();
  expect(screen.getByText(copy.success)).toBeOnTheScreen();
  expect(screen.getByTestId('dms-setup-mirrors')).toHaveTextContent(copy.successMirrors(3));
  await waitFor(async () => expect(await settings.get(DMS_CALIBRATED_KEY)).toBe(1_760_000_000_000));
  await expect(settings.get(DMS_ENABLED_KEY)).resolves.toBe(true);
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-finish'));
  });
  expect(mockRouter.back).toHaveBeenCalled();
});

test('a failure says what to fix and offers a retry; nothing is written', async () => {
  const s = scripted({ ok: false, reason: 'no_face' });
  const { settings } = await renderScreen(s.startSetup);
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-start'));
  });
  await act(async () => {
    s.finish();
  });
  expect(await screen.findByTestId('dms-setup-failed')).toBeOnTheScreen();
  expect(screen.getByText(copy.failure.no_face)).toBeOnTheScreen();
  expect(screen.getByTestId('dms-setup-retry')).toBeOnTheScreen();
  await expect(settings.get(DMS_CALIBRATED_KEY)).resolves.toBeNull();
  await expect(settings.get(DMS_ENABLED_KEY)).resolves.toBeNull();
});

test('the camera refused: the failure offers Open Settings', async () => {
  const s = scripted({ ok: false, reason: 'permission' });
  await renderScreen(s.startSetup);
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-start'));
  });
  await act(async () => {
    s.finish();
  });
  expect(await screen.findByTestId('dms-setup-failed')).toBeOnTheScreen();
  expect(screen.getByText(copy.failure.permission)).toBeOnTheScreen();
  expect(screen.getByText(dmsCopy.settings.openSettings)).toBeOnTheScreen();
});

test('no session (signed out, or a drive recording): unavailable', async () => {
  await renderScreen(async () => null);
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-start'));
  });
  expect(await screen.findByTestId('dms-setup-failed')).toBeOnTheScreen();
  expect(screen.getByText(copy.failure.unavailable)).toBeOnTheScreen();
});

test('Not now cancels the session and goes back', async () => {
  const s = scripted({ ok: false, reason: 'cancelled' });
  await renderScreen(s.startSetup);
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-start'));
  });
  await waitFor(() => expect(screen.getByTestId('dms-step-title')).toBeOnTheScreen());
  await act(async () => {
    fireEvent.press(screen.getByTestId('dms-setup-cancel'));
  });
  expect(s.session.cancelled).toBeGreaterThanOrEqual(1);
  expect(mockRouter.back).toHaveBeenCalled();
});
