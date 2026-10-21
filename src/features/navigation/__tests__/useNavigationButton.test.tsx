// The navigation button's flow (design §7.4) and its warm-up highlight (§8.4).
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { setLeaveSink } from '@/drive/leave';
import {
  NAV_HIGHLIGHT_MS,
  NAV_LOCK_MPH,
  NAV_LONG_PRESS_MS,
  NAV_UNLOCK_MPH,
  NavigationButton,
  navHighlight,
  nextNavLock,
} from '@/features/drive/NavigationButton';
import type { NavAppsPort } from '@/features/navigation/apps';
import { NAV_APP_KEY, readNavApp, writeNavApp } from '@/features/navigation/prefs';
import { useNavigationButton } from '@/features/navigation/useNavigationButton';
import { HUD } from '@/ui/drive';

const COLORS = { paper: '#FFFFFF', ink: '#111113', accent: '#1F5AD6', fill: '#1F5AD6' };

jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Light: 'light' } }));

let db: Db;
let log: string[];
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  log = [];
  setLeaveSink({ beginLeave: () => log.push('beginLeave'), cancelLeave: () => log.push('cancelLeave'), recording: () => true });
});
afterEach(() => setLeaveSink(null));

function iosPort(installed: string[], opens: () => Promise<unknown> = async () => true): NavAppsPort {
  return {
    platform: 'ios',
    canOpenURL: async (url) => installed.includes(url),
    openURL: async (url) => {
      log.push(`open ${url}`);
      return opens();
    },
    listInstalledApps: async () => [],
    launchApp: async () => false,
  };
}

async function mount(port: NavAppsPort) {
  const hook = await renderHook(() => useNavigationButton(db, port));
  await act(async () => {});
  return hook;
}

test('the first tap lists the installed apps; choosing one saves it, notes the leave before opening it, and closes the list', async () => {
  const { result } = await mount(iosPort(['waze://', 'comgooglemaps://']));
  expect(result.current.saved).toBeNull();
  await act(() => result.current.press());
  expect(result.current.picker).toEqual({ mode: 'first', apps: [expect.objectContaining({ id: 'google_maps' }), expect.objectContaining({ id: 'waze' })] });
  expect(log).toEqual([]);
  await act(() => result.current.choose(result.current.picker!.apps[1]!));
  expect(log).toEqual(['beginLeave', 'open waze://']);
  expect(result.current.picker).toBeNull();
  expect(result.current.saved).toBe('waze');
  expect(await readNavApp(db)).toBe('waze');
});

test('later taps open the saved app directly', async () => {
  await writeNavApp(db, 'waze');
  const { result } = await mount(iosPort(['waze://']));
  expect(result.current.saved).toBe('waze');
  await act(() => result.current.press());
  expect(result.current.picker).toBeNull();
  expect(log).toEqual(['beginLeave', 'open waze://']);
});

test("saved but no longer installed: the choice is cleared and the list says so", async () => {
  await writeNavApp(db, 'waze');
  const { result } = await mount(iosPort(['maps://']));
  await act(() => result.current.press());
  expect(result.current.picker).toEqual({ mode: 'gone', apps: [expect.objectContaining({ id: 'apple_maps' })], missingLabel: 'Waze' });
  expect(await readNavApp(db)).toBeNull();
  expect(result.current.saved).toBeNull();
  expect(log).toEqual([]);
});

test("an app that doesn't open: the leave is taken back and the list says so", async () => {
  await writeNavApp(db, 'waze');
  const { result } = await mount(iosPort(['waze://'], async () => Promise.reject(new Error('no'))));
  await act(() => result.current.press());
  expect(log).toEqual(['beginLeave', 'open waze://', 'cancelLeave']);
  expect(result.current.picker).toEqual({ mode: 'failed', apps: [expect.objectContaining({ id: 'waze' })], missingLabel: 'Waze' });
  // choosing it from the list again fails the same way and keeps the list up
  await act(() => result.current.choose(result.current.picker!.apps[0]!));
  expect(result.current.picker?.mode).toBe('failed');
});

test('none installed: an empty list', async () => {
  const { result } = await mount(iosPort([]));
  await act(() => result.current.press());
  expect(result.current.picker).toEqual({ mode: 'first', apps: [] });
});

test('a second tap while the open is in flight opens nothing more', async () => {
  await writeNavApp(db, 'waze');
  let finish: (v: unknown) => void = () => {};
  const { result } = await mount(iosPort(['waze://'], () => new Promise((r) => (finish = r))));
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = result.current.press();
    await Promise.resolve();
    await result.current.press();
  });
  await act(async () => {
    finish(true);
    await first;
  });
  expect(log.filter((l) => l.startsWith('open'))).toHaveLength(1);
});

test("a saved id this build does not know reads as unset: the first-tap list", async () => {
  await createSettingsRepo(db).set(NAV_APP_KEY, 'citymapper');
  const { result } = await mount(iosPort(['waze://']));
  await act(() => result.current.press());
  expect(result.current.picker?.mode).toBe('first');
});

test('Android: listed by package and launched', async () => {
  const launched: string[] = [];
  const port: NavAppsPort = {
    platform: 'android',
    canOpenURL: async () => false,
    openURL: async () => {},
    listInstalledApps: async () => [{ package: 'com.google.android.apps.maps', label: 'Maps' }],
    launchApp: async (p) => {
      launched.push(p);
      return true;
    },
  };
  const { result } = await mount(port);
  await act(() => result.current.press());
  expect(result.current.picker?.apps).toEqual([{ id: 'google_maps', label: 'Maps', target: 'com.google.android.apps.maps' }]);
  await act(() => result.current.choose(result.current.picker!.apps[0]!));
  expect(launched).toEqual(['com.google.android.apps.maps']);
  expect(log).toEqual(['beginLeave']);
});

describe('changing the saved app (the long press)', () => {
  test('lists the installed apps with nothing opened; choosing one saves it as the new default and opens it', async () => {
    await writeNavApp(db, 'waze');
    const { result } = await mount(iosPort(['waze://', 'comgooglemaps://']));
    await act(() => result.current.change());
    expect(result.current.picker).toEqual({ mode: 'change', apps: [expect.objectContaining({ id: 'google_maps' }), expect.objectContaining({ id: 'waze' })] });
    expect(log).toEqual([]);
    await act(() => result.current.choose(result.current.picker!.apps[0]!));
    expect(log).toEqual(['beginLeave', 'open comgooglemaps://']);
    expect(result.current.picker).toBeNull();
    expect(result.current.saved).toBe('google_maps');
    expect(await readNavApp(db)).toBe('google_maps');
  });

  test('closing the list keeps the saved app', async () => {
    await writeNavApp(db, 'waze');
    const { result } = await mount(iosPort(['waze://', 'comgooglemaps://']));
    await act(() => result.current.change());
    await act(async () => result.current.close());
    expect(result.current.picker).toBeNull();
    expect(await readNavApp(db)).toBe('waze');
    expect(log).toEqual([]);
  });

  test('nothing saved: it is a plain first tap', async () => {
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.change());
    expect(result.current.picker?.mode).toBe('first');
  });
});

describe('the button', () => {
  const props = { caption: 'Waze', appLabel: 'Waze', highlight: false, disabled: false, palette: HUD.day, colors: COLORS };

  test('a tap opens; a 500 ms hold changes the app; the screen reader gets a "Change navigation app" action and a hint', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    await render(<NavigationButton {...props} onPress={onPress} onLongPress={onLongPress} />);
    const button = screen.getByRole('button', { name: 'Open Waze' });
    expect(NAV_LONG_PRESS_MS).toBe(500);
    expect(button).toHaveProp('accessibilityHint', 'Touch and hold to change the navigation app.');
    expect(button).toHaveProp('accessibilityActions', [{ name: 'change', label: 'Change navigation app' }]);
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
    await fireEvent(button, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    await fireEvent(button, 'accessibilityAction', { nativeEvent: { actionName: 'change' } });
    expect(onLongPress).toHaveBeenCalledTimes(2);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('no saved app: the hold still opens the list, with no "change" action or hint (a tap already does)', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    await render(<NavigationButton {...props} caption={null} appLabel={null} onPress={onPress} onLongPress={onLongPress} />);
    const first = screen.getByRole('button', { name: 'Choose a navigation app' });
    expect(first.props.accessibilityActions).toBeUndefined();
    expect(first.props.accessibilityHint).toBeUndefined();
    await fireEvent(first, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  test('an 80 pt paper circle with an ink glyph; 64 pt in a compact slot', async () => {
    await render(<NavigationButton {...props} onPress={() => {}} />);
    expect(screen.getByTestId('hud-nav')).toHaveStyle({ width: 80, height: 80, backgroundColor: COLORS.paper });
    await render(<NavigationButton {...props} height={88} onPress={() => {}} />);
    expect(screen.getByTestId('hud-nav')).toHaveStyle({ width: 64, height: 64 });
  });

  test('disabled: no hold and no action', async () => {
    await render(<NavigationButton {...props} disabled onPress={() => {}} onLongPress={() => {}} />);
    const button = screen.getByRole('button', { name: 'Open Waze' });
    expect(button.props.accessibilityActions).toBeUndefined();
    expect(button.props.onLongPress).toBeUndefined();
  });
});

describe('the warm-up highlight', () => {
  const T = 1_790_000_000_000;
  test('for row ages under 30 s with a saved app; not at 30 s; never without one', () => {
    expect(NAV_HIGHLIGHT_MS).toBe(30_000);
    expect(navHighlight(true, T, null)).toBe(true);
    expect(navHighlight(true, T, T + 29_999)).toBe(true);
    expect(navHighlight(true, T, T + 30_000)).toBe(false);
    expect(navHighlight(false, T, T + 1_000)).toBe(false);
    expect(navHighlight(true, null, null)).toBe(false);
  });

  test('the ring renders only when asked, with the caption and the spoken label', async () => {
    await render(<NavigationButton caption="Waze" appLabel="Waze" highlight disabled={false} palette={HUD.day} colors={COLORS} onPress={() => {}} />);
    expect(screen.getByTestId('hud-nav-highlight')).toHaveStyle({ borderColor: COLORS.accent });
    expect(screen.getByRole('button', { name: 'Open Waze' })).toBeOnTheScreen();
    expect(screen.getByText('Waze')).toBeOnTheScreen();
    await render(<NavigationButton caption={null} appLabel={null} highlight={false} disabled={false} palette={HUD.day} colors={COLORS} onPress={() => {}} />);
    expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
  });
});

describe('greyed out at speed', () => {
  test('nextNavLock: locked at 35 mph and over, free under 30, held in between and with no speed', () => {
    expect([NAV_LOCK_MPH, NAV_UNLOCK_MPH]).toEqual([35, 30]);
    expect(nextNavLock(false, 34.9)).toBe(false);
    expect(nextNavLock(false, 35)).toBe(true);
    expect(nextNavLock(true, 30)).toBe(true);
    expect(nextNavLock(true, 29.9)).toBe(false);
    expect(nextNavLock(false, 32)).toBe(false);
    expect(nextNavLock(true, null)).toBe(true);
    expect(nextNavLock(false, null)).toBe(false);
    expect(nextNavLock(true, Number.NaN)).toBe(true);
  });

  test('locked: a press, a change and a choice do nothing, and an open list closes', async () => {
    await writeNavApp(db, 'waze');
    const port = iosPort(['waze://', 'maps://']);
    const hook = await renderHook(({ locked }: { locked: boolean }) => useNavigationButton(db, port, locked), { initialProps: { locked: false } });
    await act(async () => {});
    await act(() => hook.result.current.change());
    expect(hook.result.current.picker?.mode).toBe('change');
    const apps = hook.result.current.picker!.apps;
    await hook.rerender({ locked: true });
    await act(async () => {});
    expect(hook.result.current.picker).toBeNull();
    await act(() => hook.result.current.press());
    await act(() => hook.result.current.change());
    await act(() => hook.result.current.choose(apps[0]!));
    expect(hook.result.current.picker).toBeNull();
    expect(log).toEqual([]);
    expect(await readNavApp(db)).toBe('waze');
    await hook.rerender({ locked: false });
    await act(() => hook.result.current.press());
    expect(log).toEqual(['beginLeave', 'open waze://']);
  });

  test('a list a press already under way asks for never shows once it is locked', async () => {
    const waiting: (() => void)[] = [];
    const port: NavAppsPort = { ...iosPort(['waze://']), canOpenURL: (url) => new Promise((r) => waiting.push(() => r(url === 'waze://'))) };
    const hook = await renderHook(({ locked }: { locked: boolean }) => useNavigationButton(db, port, locked), { initialProps: { locked: false } });
    await act(async () => {});
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = hook.result.current.press();
      await Promise.resolve();
    });
    await hook.rerender({ locked: true });
    await act(async () => {
      for (let i = 0; i < 20; i += 1) {
        waiting.splice(0).forEach((go) => go());
        await Promise.resolve();
      }
      await pending;
    });
    expect(hook.result.current.picker).toBeNull();
  });

  test('the button: greyed (weaker, a grey face), no tap, no hold, no action, no highlight, and a hint in the driver units', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const base = { caption: 'Waze', appLabel: 'Waze', highlight: true, disabled: false, palette: HUD.day, colors: COLORS };
    await render(<NavigationButton {...base} locked onPress={onPress} onLongPress={onLongPress} />);
    const button = screen.getByRole('button', { name: 'Open Waze' });
    expect(button).toHaveProp('accessibilityState', { disabled: true });
    expect(button).toHaveProp('accessibilityHint', 'Available below 30 mph.');
    expect(button.props.accessibilityActions).toBeUndefined();
    const style = StyleSheet.flatten(button.props.style) as { opacity: number; backgroundColor: string };
    expect(style.opacity).toBe(0.55);
    expect(style.backgroundColor).not.toBe(COLORS.paper);
    expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
    await fireEvent.press(button);
    await fireEvent(button, 'longPress');
    expect(onPress).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    await render(<NavigationButton {...base} locked units="km" onPress={onPress} />);
    expect(screen.getByRole('button', { name: 'Open Waze' })).toHaveProp('accessibilityHint', 'Available below 48 km/h.');
  });
});
