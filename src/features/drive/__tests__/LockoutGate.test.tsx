import { act, render, screen } from '@testing-library/react-native';
import { AppState, BackHandler, Text } from 'react-native';

import type { DriveState } from '@/drive/host';

import { DRIVE_HREF } from '../hudCopy';
import { KEEP_AWAKE_TAG, LockoutGate } from '../LockoutGate';

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
const keepAwake = jest.requireMock<{ activateKeepAwakeAsync: jest.Mock; deactivateKeepAwake: jest.Mock }>('expo-keep-awake');

const mockRouter = { dismissTo: jest.fn(), replace: jest.fn() };
let mockPath = '/drive';
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => mockPath }));

type GateState = Pick<DriveState, 'status' | 'lockedOut'> & { waiting?: DriveState['waiting'] };
let mockState: GateState;
jest.mock('@/drive/useDrive', () => ({
  useDrive: <T,>(sel: (s: Pick<DriveState, 'status' | 'lockedOut' | 'waiting'>) => T) => sel({ waiting: null, ...mockState }),
}));

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackListener[] = [];
/** RoadWise's AppState, as the gate hears it. */
let appListeners: ((s: string) => void)[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  backHandlers = [];
  appListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, fn: (s: string) => void) => {
    appListeners.push(fn);
    return { remove: () => (appListeners = appListeners.filter((h) => h !== fn)) };
  }) as unknown as typeof AppState.addEventListener);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, fn) => {
    backHandlers.push(fn);
    return {
      remove: () => {
        backHandlers = backHandlers.filter((h) => h !== fn);
      },
    };
  });
});

const back = (): boolean => backHandlers.some((h) => h({} as never) === true);

async function renderGate(state: GateState, path: string) {
  mockState = state;
  mockPath = path;
  const r = await render(
    <LockoutGate>
      <Text>app</Text>
    </LockoutGate>
  );
  return {
    async update(next: Partial<GateState>, nextPath = mockPath) {
      mockState = { ...mockState, ...next };
      mockPath = nextPath;
      await r.rerender(
        <LockoutGate>
          <Text>app</Text>
        </LockoutGate>
      );
    },
  };
}

test('renders the app unchanged', async () => {
  await renderGate({ status: 'idle', lockedOut: false }, '/home');
  expect(screen.getByText('app')).toBeTruthy();
});

describe('Android back', () => {
  test('swallowed on the driving screen while recording', async () => {
    await renderGate({ status: 'recording', lockedOut: true }, '/drive');
    expect(back()).toBe(true);
  });

  test('released once the drive ends', async () => {
    const g = await renderGate({ status: 'recording', lockedOut: false }, '/drive');
    expect(back()).toBe(true);
    await g.update({ status: 'idle' });
    expect(back()).toBe(false);
  });

  test('left alone on other routes and with no drive', async () => {
    await renderGate({ status: 'recording', lockedOut: false }, '/friends');
    expect(back()).toBe(false);
    await act(async () => {});
    const g = await renderGate({ status: 'idle', lockedOut: false }, '/drive');
    await g.update({});
    expect(back()).toBe(false);
  });
});

const WAIT = { since: 1, phase: 'waiting' as const, deadlineAt: 2, speedMps: null, limitMph: null };

test('keep-awake holds while a Start drive swipe waits for the car, too', async () => {
  const g = await renderGate({ status: 'idle', lockedOut: false, waiting: WAIT }, '/drive');
  expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
  // the wait ends with nothing: the screen may sleep again
  await g.update({ waiting: null });
  expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
});

test('Android back is not swallowed while waiting (there is no drive yet)', async () => {
  await renderGate({ status: 'idle', lockedOut: false, waiting: WAIT }, '/drive');
  expect(back()).toBe(false);
});

test('keep-awake holds for the whole drive', async () => {
  const g = await renderGate({ status: 'idle', lockedOut: false }, '/home');
  expect(keepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
  await g.update({ status: 'recording' }, '/drive');
  expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
  await g.update({ status: 'finalizing' });
  expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
});

describe('the lockout', () => {
  test('while moving, another route on top goes back to the driving screen', async () => {
    const g = await renderGate({ status: 'recording', lockedOut: false }, '/friends');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await g.update({ lockedOut: true });
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(DRIVE_HREF);
  });

  test('does nothing on the driving screen itself', async () => {
    await renderGate({ status: 'recording', lockedOut: true }, '/drive');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('RoadWise coming to the front during a drive goes to the driving screen, even stopped', async () => {
    await renderGate({ status: 'recording', lockedOut: false }, '/drives/abc');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await act(async () => appListeners.forEach((h) => h('background')));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await act(async () => appListeners.forEach((h) => h('active')));
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(DRIVE_HREF);
  });

  test('coming to the front with no drive, or on the driving screen, changes nothing; staying in front changes nothing', async () => {
    const g = await renderGate({ status: 'idle', lockedOut: false }, '/home');
    await act(async () => appListeners.forEach((h) => h('background')));
    await act(async () => appListeners.forEach((h) => h('active')));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    // a drive starts while RoadWise stays in front, stopped: no edge, nothing moves
    await g.update({ status: 'recording' });
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await g.update({}, '/drive');
    await act(async () => appListeners.forEach((h) => h('background')));
    await act(async () => appListeners.forEach((h) => h('active')));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});
