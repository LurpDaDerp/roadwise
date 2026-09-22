import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, AccessibilityInfo, type AlertButton } from 'react-native';

import { DriveContext } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { SessionProvider, type SignOutFlushResult } from '@/data/supabase/session';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

import { DriveTabButton } from '../../../../app/(tabs)/_layout';
import Home from '../../../../app/(tabs)/home';

// `jest.mock` is hoisted; the `mock*` names below are read only from inside the mocked functions.
const mockRouter = routerDouble();
const mockCalls: string[] = [];
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: { user: { id: 'u1' } } } })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      signOut: jest.fn(async () => {
        mockCalls.push('auth.signOut');
        return { error: null };
      }),
    },
  },
}));
jest.mock('@/lib/env', () => ({ env: { diagnostics: false } }));
jest.mock('@/data/supabase/profile', () => ({
  fetchProfile: jest.fn(async () => ({ id: 'u1', display_name: 'Maya Chen' })),
}));

function fakeHost(status: DriveState['status'] = 'off') {
  const state = { status, lockedOut: false, role: 'driver', mode: 'mounted', stationarySinceTs: null } as DriveState;
  return {
    snapshot: () => state,
    subscribe: () => () => {},
    autoDetectEnabled: () => false,
  } as unknown as DriveHost;
}

async function renderHome(
  opts: { flush?: () => Promise<SignOutFlushResult>; status?: DriveState['status'] } = {}
) {
  const w = await world();
  const host = fakeHost(opts.status);
  const store = createDriveStore(host, { currentState: 'active', addEventListener: () => ({ remove() {} }) });
  await w.renderScreen(
    <SessionProvider flushBeforeSignOut={opts.flush}>
      <DriveContext.Provider value={{ host, store }}>
        <Home />
      </DriveContext.Provider>
    </SessionProvider>
  );
  // The profile has landed: the licence carries the driver's name.
  await screen.findByRole('header', { name: 'Maya Chen' });
}

const SIGN_OUT_WARNING =
  "Drives that haven't finished uploading are lost if someone else signs in on this phone.";

/** The press that answers the confirmation the way the driver would. */
function answerAlert(choice: 'Cancel' | 'Sign out') {
  const alert = jest.mocked(Alert.alert);
  const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
  buttons.find((b) => b.text === choice)?.onPress?.();
}

beforeEach(() => {
  mockCalls.length = 0;
  mockRouter.push.mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(() => {
  clearQueryClients();
  jest.restoreAllMocks();
});

test('Home prints the licence card, the record row, the detection line and Start drive', async () => {
  await renderHome();
  expect(screen.getByTestId('licence-card')).toBeOnTheScreen();
  expect(await screen.findByText('Your first drive will appear here')).toBeOnTheScreen();
  expect(screen.getByTestId('detection-status')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Start drive' }));
  expect(mockRouter.push).toHaveBeenCalledWith('/drive/start');
});

test('while a drive is running its banner leads Home, and there is no second Start drive', async () => {
  await renderHome({ status: 'recording' });
  expect(screen.getByTestId('drive-in-progress')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Start drive' })).toBeNull();
});

test('the sign-out control, its hint and its footnote are unchanged', async () => {
  await renderHome();
  const control = screen.getByRole('button', { name: 'Sign out' });
  expect({
    label: control.props.accessibilityLabel,
    hint: control.props.accessibilityHint,
    state: control.props.accessibilityState,
  }).toEqual({
    label: 'Sign out',
    hint: SIGN_OUT_WARNING,
    state: { disabled: false, busy: false },
  });
  expect(screen.getByText(SIGN_OUT_WARNING)).toBeOnTheScreen();
});

test('the Diagnostics link shows in a development build', async () => {
  await renderHome();
  expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(mockRouter.push).toHaveBeenCalledWith('/dev/drive');
});

test('and not in a release build without the diagnostics flag', async () => {
  const g = globalThis as { __DEV__?: boolean };
  const dev = g.__DEV__;
  g.__DEV__ = false;
  try {
    await renderHome();
    expect(screen.queryByRole('button', { name: 'Diagnostics' })).toBeNull();
  } finally {
    g.__DEV__ = dev;
  }
});

describe('sign-out flushes deletes first (security review D1 M-1)', () => {
  test('awaits the flush before ending the session, and asks nothing when every delete went', async () => {
    let finish: (r: SignOutFlushResult) => void = () => {};
    const flush = jest.fn(
      () =>
        new Promise<SignOutFlushResult>((resolve) => {
          mockCalls.push('flush:start');
          finish = (r) => {
            mockCalls.push('flush:end');
            resolve(r);
          };
        })
    );
    await renderHome({ flush });

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(flush).toHaveBeenCalledTimes(1);
    // The session is still open while the flush is out.
    expect(mockCalls).toEqual(['flush:start']);

    await act(async () => finish({ sent: 2, left: 0 }));
    await waitFor(() => expect(mockCalls).toEqual(['flush:start', 'flush:end', 'auth.signOut']));
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  test('a delete left unsent is named plainly, and nothing ends until the driver says so', async () => {
    const flush = jest.fn(async () => ({ sent: 0, left: 1 }));
    await renderHome({ flush });

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(jest.mocked(Alert.alert).mock.calls[0]?.[1]).toBe(
      "1 deleted drive hasn't reached the server yet. If you sign out now, it may come back. Sign out anyway?"
    );
    expect(mockCalls).toEqual([]);

    await act(async () => answerAlert('Sign out'));
    await waitFor(() => expect(mockCalls).toEqual(['auth.signOut']));
    // "Anyway" means anyway: the flush is not run a second time.
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test('several unsent deletes are counted; Cancel keeps the session', async () => {
    await renderHome({ flush: async () => ({ sent: 1, left: 3 }) });
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(jest.mocked(Alert.alert).mock.calls[0]?.[1]).toBe(
      "3 deleted drives haven't reached the server yet. If you sign out now, they may come back. Sign out anyway?"
    );

    await act(async () => answerAlert('Cancel'));
    expect(mockCalls).toEqual([]);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeOnTheScreen();
  });

  test('a flush that fails is not read as zero: the driver is asked', async () => {
    await renderHome({ flush: () => Promise.reject(new Error('offline')) });
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(jest.mocked(Alert.alert).mock.calls[0]?.[1]).toMatch(/couldn't check/);
    expect(mockCalls).toEqual([]);
  });
});

describe('the centre Drive tab', () => {
  test('its button opens the pre-drive sheet rather than a tab screen', async () => {
    const w = await world();
    await w.renderScreen(<DriveTabButton testID="drive-tab" />);
    const tab = screen.getByRole('button', { name: 'Drive' });
    expect(within(tab).getByText('Drive')).toBeOnTheScreen();
    await fireEvent.press(tab);
    expect(mockRouter.push).toHaveBeenCalledWith('/drive/start');
  });
});
