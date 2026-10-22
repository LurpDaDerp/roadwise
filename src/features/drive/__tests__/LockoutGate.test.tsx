import { act, render, screen } from '@testing-library/react-native';
import { AppState, BackHandler, Text } from 'react-native';

import type { DriveState } from '@/drive/host';

import { HOME_HREF } from '@/features/drives/routes';

import { DRIVE_HREF } from '../hudCopy';
import { resetDriveScreenPresence, setDriveScreenFocused } from '../hudPresence';
import { KEEP_AWAKE_TAG, LockoutGate } from '../LockoutGate';

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
const keepAwake = jest.requireMock<{ activateKeepAwakeAsync: jest.Mock; deactivateKeepAwake: jest.Mock }>('expo-keep-awake');

const mockRouter = { dismissTo: jest.fn(), replace: jest.fn(), navigate: jest.fn() };
let mockPath = '/drive';
/** The route's segments, from its path the way Expo Router names them. */
const segmentsOf = (path: string): string[] => {
  if (path === '/drive') return ['drive'];
  if (path === '/') return [];
  const [first, ...rest] = path.slice(1).split('/');
  if (['home', 'analytics', 'leagues', 'profile'].includes(first!)) return ['(tabs)', first!];
  if (['sign-in'].includes(first!)) return ['(auth)', first!];
  if (first === 'start') return ['(onboarding)', 'start'];
  if (first === 'update-required') return ['update-required'];
  return ['(app)', first!, ...rest];
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => mockPath, useSegments: () => segmentsOf(mockPath) }));

type DriveFields = Pick<DriveState, 'status' | 'lockedOut' | 'waiting' | 'origin' | 'clientTripId'>;
type GateState = Pick<DriveState, 'status' | 'lockedOut'> & Partial<Pick<DriveState, 'waiting' | 'origin' | 'clientTripId'>>;
let mockState: GateState;
// A drive of no stated origin is a manual one (the Start drive swipe), as before automatic drives.
jest.mock('@/drive/useDrive', () => ({
  useDrive: <T,>(sel: (s: DriveFields) => T) => sel({ waiting: null, origin: 'manual', clientTripId: 'trip-1', ...mockState }),
}));

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackListener[] = [];
/** RoadWise's AppState, as the gate hears it. */
let appListeners: ((s: string) => void)[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  resetDriveScreenPresence();
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

const toBackground = () => act(async () => appListeners.forEach((h) => h('background')));
const toFront = () => act(async () => appListeners.forEach((h) => h('active')));
/** The driving screen shows (focused, RoadWise in front) during the drive `id`, then loses focus. */
const shownFor = (id: string) =>
  act(async () => {
    setDriveScreenFocused(true, id);
    setDriveScreenFocused(false, id);
  });

describe('a manual drive owns the app from its start', () => {
  test('stated manual: the moving lockout and the return to the front both go to the driving screen', async () => {
    const g = await renderGate({ status: 'recording', lockedOut: false, origin: 'manual' }, '/drives/abc');
    await toBackground();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await toFront();
    expect(mockRouter.dismissTo).toHaveBeenLastCalledWith(DRIVE_HREF);
    await g.update({ lockedOut: true }, '/friends');
    expect(mockRouter.dismissTo).toHaveBeenLastCalledWith(DRIVE_HREF);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('going behind never moves a manual drive to Home', async () => {
    await renderGate({ status: 'recording', lockedOut: false, origin: 'manual' }, '/analytics');
    await toBackground();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});

describe('an automatic drive whose driving screen was not shown', () => {
  const AUTO = { status: 'recording' as const, origin: 'auto' as const, clientTripId: 'auto-1' };

  test('moving, the app stays usable: no route is taken over', async () => {
    const g = await renderGate({ ...AUTO, lockedOut: false }, '/home');
    await g.update({ lockedOut: true });
    await g.update({}, '/analytics');
    await g.update({}, '/drives/abc');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('coming to the front stays where it was (the Live Activity link opens the driving screen by itself)', async () => {
    await renderGate({ ...AUTO, lockedOut: true }, '/home');
    await toBackground();
    await toFront();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('going behind on another tab: Home, so the app icon opens it with the strip', async () => {
    await renderGate({ ...AUTO, lockedOut: true }, '/analytics');
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    await toBackground();
    expect(mockRouter.navigate).toHaveBeenCalledTimes(1);
    expect(mockRouter.navigate).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('going behind on a screen over the tabs: back down to Home', async () => {
    await renderGate({ ...AUTO, lockedOut: false }, '/drives/abc');
    await toBackground();
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('a drive that starts while RoadWise is behind moves the screen left open to Home', async () => {
    const g = await renderGate({ status: 'idle', lockedOut: false, origin: null, clientTripId: null }, '/settings');
    await toBackground();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await g.update(AUTO);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
  });

  test('behind on Home already, on the driving screen, or outside the app screens: nothing moves', async () => {
    const g = await renderGate({ ...AUTO, lockedOut: false }, '/home');
    await toBackground();
    await g.update({}, '/drive');
    for (const path of ['/sign-in', '/start', '/update-required', '/']) await g.update({}, path);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('inactive (Control Center, a call banner) is not behind', async () => {
    await renderGate({ ...AUTO, lockedOut: false }, '/analytics');
    await act(async () => appListeners.forEach((h) => h('inactive')));
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('no drive, or one that is over: going behind moves nothing', async () => {
    const g = await renderGate({ status: 'idle', lockedOut: false, origin: null, clientTripId: null }, '/analytics');
    await toBackground();
    await g.update({ status: 'finalizing', origin: 'auto', clientTripId: 'auto-1' });
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('the driving screen shown for another drive does not count for this one', async () => {
    await shownFor('auto-0');
    const g = await renderGate({ ...AUTO, lockedOut: false }, '/friends');
    await g.update({ lockedOut: true });
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});

describe('an automatic drive once its driving screen was shown', () => {
  const AUTO = { status: 'recording' as const, origin: 'auto' as const, clientTripId: 'auto-1' };

  test('the lockout holds as for a manual drive: moving, and on each return to the front', async () => {
    const g = await renderGate({ ...AUTO, lockedOut: false }, '/drive');
    await shownFor('auto-1');
    // a notification tap at a stop opened another screen
    await g.update({}, '/drives/abc');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    await g.update({ lockedOut: true });
    expect(mockRouter.dismissTo).toHaveBeenLastCalledWith(DRIVE_HREF);
    await g.update({ lockedOut: false });
    mockRouter.dismissTo.mockClear();
    await toBackground();
    // never Home: the driving screen is the drive's now
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    await toFront();
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(DRIVE_HREF);
  });

  test('the driving screen gaining focus while the gate shows another route applies at once', async () => {
    await renderGate({ ...AUTO, lockedOut: true }, '/home');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    // (an overlay route over the driving screen: the screen reports itself without the gate re-rendering first)
    await act(async () => setDriveScreenFocused(true, 'auto-1'));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(DRIVE_HREF);
  });

  test('the next automatic drive starts unheld again', async () => {
    await shownFor('auto-1');
    const g = await renderGate({ ...AUTO, lockedOut: true }, '/drive');
    await g.update({ status: 'idle', origin: null, clientTripId: null, lockedOut: false }, '/home');
    await g.update({ ...AUTO, clientTripId: 'auto-2', lockedOut: true }, '/analytics');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});
