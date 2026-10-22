/**
 * Home's permission card: one row with its exact line and action, "N more · See all", the tap (one
 * OS call at a time), the swipe / long press / screen-reader action that asks "Don't remind me
 * again?", and the failure line. The swipe itself is a native gesture: its props are pinned here.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert, StyleSheet, type AlertButton } from 'react-native';

import type { PermissionSnapshot } from '@/core/permissions';
import { ThemeProvider } from '@/ui/theme';

import { snap } from '../__fixtures__/harness';
import type { FixOutcome } from '../actions';
import { EMPTY_HOME_PREFS, type HomePrefs } from '../homePrefs';
import { LONG_PRESS_MS, PermissionCard, SWIPE_PANEL_W, SWIPE_THRESHOLD } from '../PermissionCard';
import type { PermissionBoardRead } from '../registry';
import type { PermissionBoard } from '../usePermissionBoard';

let mockSwipeProps: Record<string, unknown> = {};
const mockClose = jest.fn();
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = React.forwardRef(function MockSwipeable(
    props: Record<string, unknown> & { children?: ReactNode; renderRightActions?: () => ReactNode; testID?: string },
    ref
  ) {
    mockSwipeProps = props;
    React.useImperativeHandle(ref, () => ({ close: mockClose, openLeft: () => {}, openRight: () => {}, reset: () => {} }));
    return (
      <View testID={props.testID}>
        {props.renderRightActions ? props.renderRightActions() : null}
        {props.children}
      </View>
    );
  });
  return { __esModule: true, default: Mock };
});

let alert: jest.SpyInstance;
beforeEach(() => {
  mockClose.mockClear();
  mockSwipeProps = {};
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

/** An iPhone here has automatic drives' permissions unless a test says otherwise. */
function read(over: Partial<PermissionSnapshot> = {}): PermissionBoardRead {
  const snapshot = snap({ ...(over.platform === 'ios' ? { location: 'always' as const, backgroundRefresh: 'available' as const } : {}), ...over });
  return { snapshot, androidApi: snapshot.platform === 'android' ? 34 : null, paired: false, bluetooth: null, camera: null };
}

function fakeBoard(r: PermissionBoardRead | null, prefs: HomePrefs = EMPTY_HOME_PREFS, status: PermissionBoard['status'] = 'ready') {
  const b: PermissionBoard & { fix: jest.Mock; hide: jest.Mock } = {
    status,
    read: r,
    prefs,
    refresh: jest.fn(async () => {}),
    fix: jest.fn(async (): Promise<FixOutcome | null> => ({ kind: 'opened' })),
    hide: jest.fn(async () => {}),
    show: jest.fn(async () => {}),
  };
  return b;
}

async function draw(board: PermissionBoard, opts: { recording?: boolean; autoDisabled?: boolean; onSeeAll?: () => void } = {}) {
  const ui = (b: PermissionBoard) => (
    <ThemeProvider>
      <PermissionCard board={b} recording={opts.recording ?? false} autoDisabled={opts.autoDisabled} onSeeAll={opts.onSeeAll ?? (() => {})} />
    </ThemeProvider>
  );
  const r = await render(ui(board));
  return { rerender: (b: PermissionBoard) => r.rerender(ui(b)) };
}

const lastAlert = () => alert.mock.calls[alert.mock.calls.length - 1] as [string, string, AlertButton[], { cancelable: boolean; onDismiss: () => void }];

const allOff = read({ platform: 'ios', location: 'undetermined', precise: null, motion: 'undetermined', notifications: 'undetermined' });

test('one row with the exact line and Allow, plus "2 more · See all", which opens Settings › Permissions', async () => {
  const onSeeAll = jest.fn();
  await draw(fakeBoard(allOff), { onSeeAll });
  expect(screen.getByTestId('home-permission-line')).toHaveTextContent('Allow Location so drives can record.');
  expect(screen.getByTestId('home-permission-action')).toHaveTextContent('Allow');
  expect(screen.getByTestId('home-permissions-more')).toHaveTextContent('2 more', { exact: false });
  expect(screen.getByTestId('home-permissions-more')).toHaveTextContent('See all', { exact: false });
  expect(screen.getByTestId('home-permissions-more').props.accessibilityLabel).toBe('2 more permissions need a look. See all.');
  fireEvent.press(screen.getByTestId('home-permissions-more'));
  expect(onSeeAll).toHaveBeenCalledTimes(1);
  // Touch targets are 44 pt or more everywhere.
  for (const id of ['home-permissions-more', 'home-permission-location']) {
    expect(StyleSheet.flatten(screen.getByTestId(id).props.style).minHeight).toBeGreaterThanOrEqual(44);
  }
  expect(screen.queryAllByTestId(/^home-permission-(location|motion|notifications)$/)).toHaveLength(1);
});

test('a row that can only be fixed in Settings says Open Settings; one row alone has no "more" line', async () => {
  await draw(fakeBoard(read({ platform: 'ios', motion: 'denied' })));
  expect(screen.getByTestId('home-permission-line')).toHaveTextContent('Motion & Fitness is off. Drives won’t start themselves.');
  expect(screen.getByTestId('home-permission-action')).toHaveTextContent('Open Settings');
  expect(screen.queryByTestId('home-permissions-more')).toBeNull();
});

test('with Automatic drives switched off, no Location Always or Background App Refresh row; Motion still shows', async () => {
  const autoOnly = read({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied' });
  await draw(fakeBoard(autoOnly));
  expect(screen.getByTestId('home-permission-line')).toHaveTextContent('Set Location to Always so drives start themselves.');
  await draw(fakeBoard(autoOnly), { autoDisabled: true });
  expect(screen.queryByTestId('home-permissions')).toBeNull();
  await draw(fakeBoard(read({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied', motion: 'denied' })), { autoDisabled: true });
  expect(screen.getByTestId('home-permission-motion')).toBeOnTheScreen();
  expect(screen.queryByTestId('home-permissions-more')).toBeNull();
});

test('a request that had no effect on this state shows Open Settings', async () => {
  await draw(fakeBoard(read({ platform: 'android', motion: 'denied' }), { hidden: [], toSettings: { motion: 'denied:true' } }));
  expect(screen.getByTestId('home-permission-action')).toHaveTextContent('Open Settings');
});

test('nothing while loading, on a read error, while recording, or with nothing missing', async () => {
  const cases: PermissionBoard[] = [fakeBoard(null, EMPTY_HOME_PREFS, 'loading'), fakeBoard(null, EMPTY_HOME_PREFS, 'error'), fakeBoard(read())];
  for (const b of cases) {
    await draw(b);
    expect(screen.queryByTestId('home-permissions')).toBeNull();
  }
  await draw(fakeBoard(allOff), { recording: true });
  expect(screen.queryByTestId('home-permissions')).toBeNull();
});

test('the required rows wear the danger glyph; the rest the warning outline', async () => {
  await draw(fakeBoard(read({ precise: false })));
  expect(screen.getByTestId('home-permission-line')).toHaveTextContent("Precise Location is off. Drives can't record.");
});

test('the swipe: right-to-left only, a 120 pt panel it reaches at 72 pt, no overshoot', async () => {
  await draw(fakeBoard(allOff));
  expect(mockSwipeProps.renderLeftActions).toBeUndefined();
  expect(typeof mockSwipeProps.renderRightActions).toBe('function');
  expect(mockSwipeProps.rightThreshold).toBe(SWIPE_THRESHOLD);
  expect(SWIPE_THRESHOLD).toBeLessThanOrEqual(SWIPE_PANEL_W);
  expect(SWIPE_PANEL_W).toBe(120);
  expect(SWIPE_THRESHOLD).toBe(72);
  expect(mockSwipeProps.overshootRight).toBe(false);
  expect(mockSwipeProps.enabled).toBe(true);
  expect(screen.getByTestId('home-permission-swipe-panel', { includeHiddenElements: true })).toHaveTextContent("Don't remind me", { exact: false });
});

test('a swipe asks "Don\'t remind me again?" naming the permission; Cancel and a dismiss close it and keep the row', async () => {
  const board = fakeBoard(read({ platform: 'ios', motion: 'denied' }));
  await draw(board);
  await act(async () => {
    (mockSwipeProps.onSwipeableOpen as () => void)();
  });
  const [title, message, buttons, options] = lastAlert();
  expect(title).toBe("Don't remind me again?");
  expect(message).toBe("Home won't remind you about Motion & Fitness again. You can undo this in Profile › Settings › Permissions.");
  expect(buttons.map((b) => [b.text, b.style])).toEqual([
    ['Cancel', 'cancel'],
    ["Don't remind me", 'destructive'],
  ]);
  expect(options.cancelable).toBe(true);
  await act(async () => {
    buttons[0]!.onPress?.();
  });
  expect(mockClose).toHaveBeenCalledTimes(1);
  await act(async () => {
    (mockSwipeProps.onSwipeableOpen as () => void)();
  });
  await act(async () => {
    lastAlert()[3].onDismiss();
  });
  expect(mockClose).toHaveBeenCalledTimes(2);
  expect(board.hide).not.toHaveBeenCalled();
});

test("Don't remind me hides that row", async () => {
  const board = fakeBoard(read({ platform: 'android', notifications: 'denied', notificationsCanAskAgain: false }));
  await draw(board);
  await act(async () => {
    (mockSwipeProps.onSwipeableOpen as () => void)();
  });
  await act(async () => {
    lastAlert()[2][1]!.onPress?.();
  });
  expect(board.hide).toHaveBeenCalledWith('notifications');
});

test('a hide that could not be stored keeps the row, closes the swipe and says so', async () => {
  const board = fakeBoard(read({ platform: 'android', motion: 'denied' }));
  board.hide.mockRejectedValue(new Error('disk'));
  await draw(board);
  await act(async () => {
    (mockSwipeProps.onSwipeableOpen as () => void)();
  });
  await act(async () => {
    lastAlert()[2][1]!.onPress?.();
  });
  expect(mockClose).toHaveBeenCalled();
  expect(screen.getByTestId('home-permission-line')).toHaveTextContent("That didn't work. Try again.");
});

test('the row is one button with its line and action, no hint; the dismiss action and a long press open the same question; activate taps', async () => {
  const board = fakeBoard(read({ platform: 'ios', motion: 'denied' }));
  await draw(board);
  const row = screen.getByTestId('home-permission-motion');
  expect(row.props.accessibilityRole).toBe('button');
  expect(row.props.accessibilityLabel).toBe('Motion & Fitness is off. Drives won’t start themselves. Open Settings.');
  expect(row.props.accessibilityHint).toBeUndefined();
  expect(row.props.accessibilityActions).toEqual([{ name: 'activate' }, { name: 'dismiss', label: "Don't remind me again" }]);
  expect(LONG_PRESS_MS).toBe(500);
  await act(async () => {
    fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'dismiss' } });
  });
  expect(alert).toHaveBeenCalledTimes(1);
  await act(async () => {
    lastAlert()[2][0]!.onPress?.();
  });
  await act(async () => {
    fireEvent(row, 'longPress');
  });
  expect(alert).toHaveBeenCalledTimes(2);
  await act(async () => {
    lastAlert()[2][0]!.onPress?.();
  });
  await act(async () => {
    fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  });
  expect(board.fix).toHaveBeenCalledWith('motion');
});

test('a tap runs the fix once; a second tap while busy does nothing and the swipe is off meanwhile', async () => {
  const board = fakeBoard(read({ platform: 'android', motion: 'undetermined' }));
  let resolve: (v: FixOutcome) => void = () => {};
  board.fix.mockImplementation(() => new Promise<FixOutcome>((r) => (resolve = r)));
  await draw(board);
  await act(async () => {
    fireEvent.press(screen.getByTestId('home-permission-motion'));
  });
  expect(screen.getByTestId('home-permission-busy')).toBeOnTheScreen();
  expect(mockSwipeProps.enabled).toBe(false);
  await act(async () => {
    fireEvent.press(screen.getByTestId('home-permission-motion'));
  });
  expect(board.fix).toHaveBeenCalledTimes(1);
  await act(async () => {
    (mockSwipeProps.onSwipeableOpen as () => void)();
  });
  expect(alert).not.toHaveBeenCalled();
  await act(async () => resolve({ kind: 'requested', read: null, noEffect: false }));
  await waitFor(() => expect(screen.queryByTestId('home-permission-busy')).toBeNull());
});

test('a fix that fails shows "That didn\'t work. Try again." in the row until the next read', async () => {
  const board = fakeBoard(read({ platform: 'android', motion: 'undetermined' }));
  board.fix.mockRejectedValue(new Error('bridge'));
  const d = await draw(board);
  await act(async () => {
    fireEvent.press(screen.getByTestId('home-permission-motion'));
  });
  expect(screen.getByTestId('home-permission-line')).toHaveTextContent("That didn't work. Try again.");
  d.rerender({ ...board, read: read({ platform: 'android', motion: 'undetermined' }) });
  await waitFor(() => expect(screen.getByTestId('home-permission-line')).toHaveTextContent('Allow Physical activity so walking away ends a drive.'));
});

test('hiding the shown row shows the next one; a hidden row stays hidden', async () => {
  const r = read({ platform: 'ios', location: 'undetermined', precise: null, motion: 'denied' });
  const d = await draw(fakeBoard(r));
  expect(screen.getByTestId('home-permission-location')).toBeOnTheScreen();
  d.rerender(fakeBoard(r, { hidden: ['location'], toSettings: {} }));
  await waitFor(() => expect(screen.getByTestId('home-permission-motion')).toBeOnTheScreen());
  expect(screen.queryByTestId('home-permission-location')).toBeNull();
  expect(screen.queryByTestId('home-permissions-more')).toBeNull();
});

test('Background App Refresh and Bluetooth rows never offer Allow', async () => {
  const r = { ...read({ platform: 'ios', location: 'always', backgroundRefresh: 'denied' }), paired: true, bluetooth: 'denied' as const };
  await draw(fakeBoard(r));
  expect(screen.getByTestId('home-permission-backgroundRefresh')).toBeOnTheScreen();
  expect(screen.getByText('Turn on Background App Refresh to catch every drive.')).toBeOnTheScreen();
  expect(screen.getByTestId('home-permission-action')).toHaveTextContent('Open Settings');
  expect(screen.getByTestId('home-permissions-more')).toHaveTextContent('1 more', { exact: false });
  await draw(fakeBoard({ ...r, snapshot: { ...r.snapshot, backgroundRefresh: 'available' } }));
  expect(screen.getAllByTestId('home-permission-bluetooth')[0]).toBeOnTheScreen();
  expect(screen.getAllByTestId('home-permission-action').map((n) => n.props.children)).not.toContain('Allow');
});

test('an iPhone kept at While Using shows the Location Always line on Home', async () => {
  await draw(fakeBoard(read({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'available' })));
  expect(screen.getByTestId('home-permission-locationAlways')).toBeOnTheScreen();
  expect(screen.getByText('Set Location to Always so drives start themselves.')).toBeOnTheScreen();
});
