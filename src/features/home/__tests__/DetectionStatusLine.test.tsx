import { act, fireEvent, screen } from '@testing-library/react-native';

import { APP_CONFIG_KEY } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { DriveContext } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { DetectionStatusLine, detectionLineState } from '@/features/home/DetectionStatusLine';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

/** `armed` defaults to what an idle host would publish: armed exactly when its status is. */
function fakeHost(status: DriveState['status'], intent: boolean, armed = status === 'armed') {
  let state = { status, autoDetectArmed: armed } as DriveState;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => state,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    autoDetectEnabled: () => intent,
  } as unknown as DriveHost;
  return {
    host,
    move(next: DriveState['status'], nextArmed = next === 'armed') {
      state = { ...state, status: next, autoDetectArmed: nextArmed };
      for (const l of listeners) l(state);
    },
  };
}

async function renderLine(status: DriveState['status'], intent: boolean, flag?: boolean, armed?: boolean) {
  const w = await world();
  if (flag !== undefined) {
    await createSettingsRepo(w.db).set(APP_CONFIG_KEY, { fetchedAt: 1, flags: { auto_detect: flag } });
  }
  const fake = fakeHost(status, intent, armed);
  const store = createDriveStore(fake.host, { currentState: 'active', addEventListener: () => ({ remove() {} }) });
  await w.renderScreen(
    <DriveContext.Provider value={{ host: fake.host, store }}>
      <DetectionStatusLine />
    </DriveContext.Provider>
  );
  return fake;
}

beforeEach(() => mockRouter.push.mockClear());
afterEach(clearQueryClients);

test('what the line may claim follows the intent, the host\'s published arming and the flag', () => {
  expect(detectionLineState(true, true, true)).toBe('on');
  // Asked for, but the host is not armed (permissions, a refused arm, signed out).
  expect(detectionLineState(true, false, true)).toBe('notRunning');
  // A withdrawn flag is named as the reason even after an opt-in (review U4 m3).
  expect(detectionLineState(true, false, false)).toBe('unavailable');
  expect(detectionLineState(true, true, false)).toBe('unavailable');
  expect(detectionLineState(false, false, true)).toBe('manual');
  expect(detectionLineState(false, false, null)).toBe('manual');
  // A server flag that is off makes the feature unavailable, never "turned off" (D2 M-2).
  expect(detectionLineState(false, false, false)).toBe('unavailable');
});

test('a manual drive while auto-record is not armed never says "on" (final review M3)', async () => {
  const fake = await renderLine('recording', true, undefined, false);
  expect(await screen.findByText("Auto-record is on but isn't running")).toBeOnTheScreen();
  await act(async () => fake.move('recording', true));
  expect(screen.getByText('Auto-record is on')).toBeOnTheScreen();
});

test('opted in and armed: "Auto-record is on", and the row opens the detection screen', async () => {
  await renderLine('armed', true);
  expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Auto-record is on, Auto-record settings' }));
  expect(mockRouter.push).toHaveBeenCalledWith('/detection');
});

test('opted in but the host is off: never claims it is on', async () => {
  const fake = await renderLine('off', true);
  expect(await screen.findByText("Auto-record is on but isn't running")).toBeOnTheScreen();
  expect(screen.queryByText('Auto-record is on')).toBeNull();

  await act(async () => fake.move('armed'));
  expect(screen.getByText('Auto-record is on')).toBeOnTheScreen();
});

test('not opted in: manual mode, with how to record', async () => {
  await renderLine('off', false);
  expect(await screen.findByText('Manual mode')).toBeOnTheScreen();
  expect(screen.getByText('Tap Start drive to record a drive.')).toBeOnTheScreen();
});

test('the server flag off: unavailable, not manual by choice', async () => {
  await renderLine('off', false, false);
  expect(await screen.findByText('Auto-record isn’t available yet')).toBeOnTheScreen();
  expect(screen.queryByText('Manual mode')).toBeNull();
});

test('opted in, then the server withdrew the flag: says unavailable, not merely not running', async () => {
  await renderLine('off', true, false);
  expect(await screen.findByText('Auto-record isn’t available yet')).toBeOnTheScreen();
  expect(screen.queryByText("Auto-record is on but isn't running")).toBeNull();
});
