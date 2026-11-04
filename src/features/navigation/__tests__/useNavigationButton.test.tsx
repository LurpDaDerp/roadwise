// The navigation button's flow (design §7.4) and its warm-up highlight (§8.4).
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import {
  NAV_HIGHLIGHT_MS,
  NAV_LOCK_MPH,
  NAV_LONG_PRESS_MS,
  NAV_UNLOCK_MPH,
  NavigationButton,
  navHighlight,
  nextNavLock,
} from '@/features/drive/NavigationButton';
import type { InstalledNavApp, NavAppsPort } from '@/features/navigation/apps';
import { NAV_APP_KEY, readNavApp, writeNavApp } from '@/features/navigation/prefs';
import { NAV_OPEN_TIMEOUT_MS, useNavigationButton, type NavPicker } from '@/features/navigation/useNavigationButton';
import { HUD } from '@/ui/drive';

const COLORS = { paper: '#FFFFFF', ink: '#111113', accent: '#1F5AD6', fill: '#1F5AD6' };

jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Light: 'light' } }));

let db: Db;
let log: string[];
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  log = [];
});

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

/** The list's apps (any list but "Where to?"). */
function appsOf(picker: NavPicker): InstalledNavApp[] {
  if (picker === null || picker.mode === 'places') throw new Error(`no list of apps: ${JSON.stringify(picker)}`);
  return picker.apps;
}

async function mount(port: NavAppsPort) {
  const hook = await renderHook(() => useNavigationButton(db, port));
  await act(async () => {});
  return hook;
}

test('the first tap lists the installed apps; choosing one saves it, opens it, and closes the list', async () => {
  const { result } = await mount(iosPort(['waze://', 'comgooglemaps://']));
  expect(result.current.saved).toBeNull();
  await act(() => result.current.press());
  expect(result.current.picker).toEqual({ mode: 'first', apps: [expect.objectContaining({ id: 'google_maps' }), expect.objectContaining({ id: 'waze' })] });
  expect(log).toEqual([]);
  await act(() => result.current.choose(appsOf(result.current.picker)[1]!));
  expect(log).toEqual(['open waze://']);
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
  expect(log).toEqual(['open waze://']);
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

test("an app that doesn't open: the list says so", async () => {
  await writeNavApp(db, 'waze');
  const { result } = await mount(iosPort(['waze://'], async () => Promise.reject(new Error('no'))));
  await act(() => result.current.press());
  expect(log).toEqual(['open waze://']);
  expect(result.current.picker).toEqual({ mode: 'failed', apps: [expect.objectContaining({ id: 'waze' })], missingLabel: 'Waze' });
  // choosing it from the list again fails the same way and keeps the list up
  await act(() => result.current.choose(appsOf(result.current.picker)[0]!));
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
  expect(appsOf(result.current.picker)).toEqual([{ id: 'google_maps', label: 'Maps', target: 'com.google.android.apps.maps' }]);
  await act(() => result.current.choose(appsOf(result.current.picker)[0]!));
  expect(launched).toEqual(['com.google.android.apps.maps']);
  expect(log).toEqual([]);
});

describe('changing the saved app (the long press)', () => {
  test('lists the installed apps with nothing opened; choosing one saves it as the new default and opens it', async () => {
    await writeNavApp(db, 'waze');
    const { result } = await mount(iosPort(['waze://', 'comgooglemaps://']));
    await act(() => result.current.change());
    expect(result.current.picker).toEqual({ mode: 'change', apps: [expect.objectContaining({ id: 'google_maps' }), expect.objectContaining({ id: 'waze' })] });
    expect(log).toEqual([]);
    await act(() => result.current.choose(appsOf(result.current.picker)[0]!));
    expect(log).toEqual(['open comgooglemaps://']);
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
    const apps = appsOf(hook.result.current.picker);
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
    expect(log).toEqual(['open waze://']);
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

describe('"Where to?": the saved places (round 14)', () => {
  const home = { id: 'home', kind: 'home', name: 'Home', address: '12 Oak St', area: 'Seattle, WA 98104', lat: 47.6062104, lng: -122.3320708 } as const;
  const school = { id: 'school', kind: 'school', name: 'School', address: 'Lincoln High', area: '', lat: 47.65, lng: -122.35 } as const;
  const gym = { id: 'place-abc', kind: 'custom', name: 'Gym', address: '', area: '', lat: 47.61, lng: -122.2 } as const;
  const seed = (places: unknown) => createSettingsRepo(db).set('places.saved', places);
  const placesOf = (picker: NavPicker) => {
    if (picker === null || picker.mode !== 'places') throw new Error(`not "Where to?": ${JSON.stringify(picker)}`);
    return picker;
  };

  test('a tap with places saved and an app that takes a destination: the places in Home, Work, School, own order, then the app; nothing opens yet', async () => {
    await writeNavApp(db, 'waze');
    // stored out of order: the list still reads Home, School, then the driver's own
    await seed([gym, school, home]);
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.press());
    const list = placesOf(result.current.picker);
    expect(list.app).toEqual({ id: 'waze', label: 'Waze', target: 'waze://' });
    expect(list.places.map((p) => p.id)).toEqual(['home', 'school', 'place-abc']);
    expect(log).toEqual([]);
  });

  test('a place opens the app with driving directions to its point and closes the list; the saved app stays', async () => {
    await writeNavApp(db, 'waze');
    await seed([home, school]);
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.press());
    await act(() => result.current.goTo(placesOf(result.current.picker).places[0]!));
    expect(log).toEqual(['open waze://?ll=47.606210,-122.332071&navigate=yes']);
    expect(result.current.picker).toBeNull();
    expect(await readNavApp(db)).toBe('waze');
  });

  test('"Open {app}" opens the app bare, as a plain tap does (a route in progress kept)', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.press());
    await act(() => result.current.openApp());
    expect(log).toEqual(['open waze://']);
    expect(result.current.picker).toBeNull();
  });

  test('Apple Maps and Google Maps on iPhone get their own URLs', async () => {
    await seed([home]);
    await writeNavApp(db, 'apple_maps');
    const a = await mount(iosPort(['maps://', 'comgooglemaps://']));
    await act(() => a.result.current.press());
    await act(() => a.result.current.goTo(home));
    await writeNavApp(db, 'google_maps');
    const g = await mount(iosPort(['maps://', 'comgooglemaps://']));
    await act(() => g.result.current.press());
    await act(() => g.result.current.goTo(home));
    expect(log).toEqual(['open maps://?daddr=47.606210,-122.332071&dirflg=d', 'open comgooglemaps://?daddr=47.606210,-122.332071&directionsmode=driving']);
  });

  test('hasPlaces: false with no app, or an app with no destination; true once places it can reach are saved; refreshed by a tap', async () => {
    await seed([home]);
    const none = await mount(iosPort(['waze://']));
    expect(none.result.current.hasPlaces).toBe(false);
    await writeNavApp(db, 'here');
    const here = await mount(iosPort(['here-route://']));
    expect(here.result.current.hasPlaces).toBe(false);
    await writeNavApp(db, 'waze');
    const waze = await mount(iosPort(['waze://']));
    expect(waze.result.current.hasPlaces).toBe(true);
    // the places are gone: the next tap opens Waze and the label follows
    await seed([]);
    await act(() => waze.result.current.press());
    expect(waze.result.current.hasPlaces).toBe(false);
    expect(log).toEqual(['open waze://']);
  });

  test('the button says "Navigate with {app}" when a tap shows places, and only then', async () => {
    const base = { caption: 'Waze', appLabel: 'Waze', highlight: false, disabled: false, palette: HUD.day, colors: COLORS, onPress: () => {} };
    const view = await render(<NavigationButton {...base} places onLongPress={() => {}} />);
    expect(screen.getByTestId('hud-nav')).toHaveProp('accessibilityLabel', 'Navigate with Waze');
    expect(screen.getByTestId('hud-nav')).toHaveProp('accessibilityHint', 'Shows your saved places first. Touch and hold to change the navigation app.');
    await view.rerender(<NavigationButton {...base} places />);
    expect(screen.getByTestId('hud-nav')).toHaveProp('accessibilityHint', 'Shows your saved places first.');
    await view.rerender(<NavigationButton {...base} places locked />);
    expect(screen.getByTestId('hud-nav')).toHaveProp('accessibilityHint', 'Available below 30 mph.');
    await view.rerender(<NavigationButton {...base} />);
    expect(screen.getByTestId('hud-nav')).toHaveProp('accessibilityLabel', 'Open Waze');
    expect(screen.getByTestId('hud-nav').props.accessibilityHint).toBeUndefined();
    await view.rerender(<NavigationButton {...base} caption={null} appLabel={null} places />);
    expect(screen.getByTestId('hud-nav')).toHaveProp('accessibilityLabel', 'Choose a navigation app');
  });

  test('no places saved: the tap opens the app directly, as before', async () => {
    await writeNavApp(db, 'waze');
    await seed([]);
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.press());
    expect(result.current.picker).toBeNull();
    expect(log).toEqual(['open waze://']);
  });

  test('a saved app with no destination (HERE WeGo): the tap opens it directly, places or not', async () => {
    await writeNavApp(db, 'here');
    await seed([home]);
    const { result } = await mount(iosPort(['here-route://', 'waze://']));
    await act(() => result.current.press());
    expect(result.current.picker).toBeNull();
    expect(log).toEqual(['open here-route://']);
  });

  test('a place list that will not read, or holds nothing usable: the tap opens the app directly', async () => {
    await writeNavApp(db, 'waze');
    await seed('not a list');
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.press());
    await seed([{ id: 'home', kind: 'home', name: 'Home', address: '', area: '', lat: 'x', lng: 0 }, { name: '' }]);
    await act(() => result.current.press());
    expect(log).toEqual(['open waze://', 'open waze://']);
    expect(result.current.picker).toBeNull();
  });

  test('a database that fails on the places read: the tap opens the app directly', async () => {
    await writeNavApp(db, 'waze');
    const real = db;
    const flaky = { ...real, execute: (sql: string, params?: unknown[]) => (params?.[0] === 'places.saved' ? Promise.reject(new Error('disk')) : real.execute(sql, params as never)) } as Db;
    const port = iosPort(['waze://']);
    const { result } = await renderHook(() => useNavigationButton(flaky, port));
    await act(async () => {});
    await act(() => result.current.press());
    expect(log).toEqual(['open waze://']);
    expect(result.current.picker).toBeNull();
  });

  test('the saved app is gone: the "not on this phone" list, never the places', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['maps://']));
    await act(() => result.current.press());
    expect(result.current.picker).toEqual({ mode: 'gone', apps: [expect.objectContaining({ id: 'apple_maps' })], missingLabel: 'Waze' });
    expect(log).toEqual([]);
  });

  test('nothing saved: the first tap is the list of apps, with no places in it; choosing opens the app bare', async () => {
    await seed([home]);
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.press());
    expect(result.current.picker).toEqual({ mode: 'first', apps: [expect.objectContaining({ id: 'waze' })] });
    await act(() => result.current.choose(appsOf(result.current.picker)[0]!));
    expect(log).toEqual(['open waze://']);
    // the next tap is "Where to?"
    await act(() => result.current.press());
    expect(placesOf(result.current.picker).places).toHaveLength(1);
  });

  test('the long press is the list of apps, with no places in it', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['waze://', 'maps://']));
    await act(() => result.current.press());
    expect(result.current.picker?.mode).toBe('places');
    await act(() => result.current.change());
    expect(result.current.picker).toEqual({ mode: 'change', apps: [expect.objectContaining({ id: 'apple_maps' }), expect.objectContaining({ id: 'waze' })] });
  });

  test("a place that doesn't open: the list of apps, saying the app didn't open", async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['waze://', 'maps://'], async () => Promise.reject(new Error('no'))));
    await act(() => result.current.press());
    await act(() => result.current.goTo(home));
    expect(log).toEqual(['open waze://?ll=47.606210,-122.332071&navigate=yes']);
    expect(result.current.picker).toEqual({ mode: 'failed', apps: [expect.objectContaining({ id: 'apple_maps' }), expect.objectContaining({ id: 'waze' })], missingLabel: 'Waze' });
  });

  test(`"Open {app}" that doesn't open: the same`, async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['waze://'], async () => Promise.reject(new Error('no'))));
    await act(() => result.current.press());
    await act(() => result.current.openApp());
    expect(result.current.picker).toEqual({ mode: 'failed', apps: [expect.objectContaining({ id: 'waze' })], missingLabel: 'Waze' });
  });

  test('an open that has not answered in 3 s counts as done: the list closes', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['waze://'], () => new Promise(() => {})));
    await act(() => result.current.press());
    jest.useFakeTimers();
    try {
      let going: Promise<void> = Promise.resolve();
      await act(async () => {
        going = result.current.goTo(home);
        await Promise.resolve();
      });
      expect(result.current.picker?.mode).toBe('places');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(NAV_OPEN_TIMEOUT_MS - 1);
      });
      expect(result.current.picker?.mode).toBe('places');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
        await going;
      });
      expect(result.current.picker).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a second tap while a place is opening opens nothing more', async () => {
    await writeNavApp(db, 'waze');
    await seed([home, school]);
    let finish: (v: unknown) => void = () => {};
    let opens = 0;
    const { result } = await mount(iosPort(['waze://'], () => (++opens === 1 ? new Promise((r) => (finish = r)) : Promise.resolve(true))));
    await act(() => result.current.press());
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.goTo(home);
      await Promise.resolve();
      await result.current.goTo(school);
      await result.current.openApp();
      await result.current.press();
    });
    await act(async () => {
      finish(true);
      await first;
    });
    expect(log).toEqual(['open waze://?ll=47.606210,-122.332071&navigate=yes']);
    expect(result.current.picker).toBeNull();
  });

  test('with no "Where to?" list up, a place or "Open {app}" does nothing', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const { result } = await mount(iosPort(['waze://']));
    await act(() => result.current.goTo(home));
    await act(() => result.current.openApp());
    await act(() => result.current.change());
    await act(() => result.current.goTo(home));
    expect(log).toEqual([]);
    expect(result.current.picker?.mode).toBe('change');
  });

  test('locked: the list closes, and a place or "Open {app}" does nothing until it is free', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
    const port = iosPort(['waze://']);
    const hook = await renderHook(({ locked }: { locked: boolean }) => useNavigationButton(db, port, locked), { initialProps: { locked: false } });
    await act(async () => {});
    await act(() => hook.result.current.press());
    expect(hook.result.current.picker?.mode).toBe('places');
    // the handlers a row held from before the lock
    const goTo = hook.result.current.goTo;
    const openApp = hook.result.current.openApp;
    await hook.rerender({ locked: true });
    await act(async () => {});
    expect(hook.result.current.picker).toBeNull();
    await act(() => goTo(home));
    await act(() => openApp());
    await act(() => hook.result.current.press());
    expect(log).toEqual([]);
    expect(hook.result.current.picker).toBeNull();
    await hook.rerender({ locked: false });
    await act(() => hook.result.current.press());
    expect(hook.result.current.picker?.mode).toBe('places');
  });

  test('a "Where to?" list a press already under way asks for never shows once it is locked', async () => {
    await writeNavApp(db, 'waze');
    await seed([home]);
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
      for (let i = 0; i < 40; i += 1) {
        waiting.splice(0).forEach((go) => go());
        await new Promise((r) => setTimeout(r, 0));
      }
      await pending;
    });
    expect(hook.result.current.picker).toBeNull();
    expect(log).toEqual([]);
  });

  describe('Android', () => {
    function androidPort(packages: { package: string; label: string }[], opens: (url: string) => Promise<unknown> = async () => true) {
      const launched: string[] = [];
      const port: NavAppsPort = {
        platform: 'android',
        canOpenURL: async () => false,
        openURL: async (url) => {
          log.push(`open ${url}`);
          return opens(url);
        },
        listInstalledApps: async () => packages,
        launchApp: async (p) => {
          launched.push(p);
          return true;
        },
      };
      return { port, launched };
    }

    test('Google Maps: a place opens google.navigation through the phone; "Open Maps" launches the package', async () => {
      await writeNavApp(db, 'google_maps');
      await seed([home]);
      const { port, launched } = androidPort([{ package: 'com.google.android.apps.maps', label: 'Maps' }]);
      const { result } = await mount(port);
      await act(() => result.current.press());
      expect(placesOf(result.current.picker).app).toEqual({ id: 'google_maps', label: 'Maps', target: 'com.google.android.apps.maps' });
      await act(() => result.current.goTo(home));
      expect(log).toEqual(['open google.navigation:q=47.606210,-122.332071&mode=d']);
      expect(launched).toEqual([]);
      await act(() => result.current.press());
      await act(() => result.current.openApp());
      expect(launched).toEqual(['com.google.android.apps.maps']);
      expect(log).toHaveLength(1);
    });

    test('Waze: its own URL', async () => {
      await writeNavApp(db, 'waze');
      await seed([home]);
      const { port } = androidPort([{ package: 'com.waze', label: 'Waze' }]);
      const { result } = await mount(port);
      await act(() => result.current.press());
      await act(() => result.current.goTo(home));
      expect(log).toEqual(['open waze://?ll=47.606210,-122.332071&navigate=yes']);
    });

    test('Maps Go has no destination: the tap launches it, as before', async () => {
      await writeNavApp(db, 'google_maps_go_nav');
      await seed([home]);
      const { port, launched } = androidPort([{ package: 'com.google.android.apps.navlite', label: 'Maps Go' }]);
      const { result } = await mount(port);
      await act(() => result.current.press());
      expect(result.current.picker).toBeNull();
      expect(launched).toEqual(['com.google.android.apps.navlite']);
      expect(log).toEqual([]);
    });

    test("a place that doesn't open (no app takes the link): the list of apps, saying so", async () => {
      await writeNavApp(db, 'google_maps');
      await seed([home]);
      const { port } = androidPort([{ package: 'com.google.android.apps.maps', label: 'Maps' }], async () => Promise.reject(new Error('ActivityNotFound')));
      const { result } = await mount(port);
      await act(() => result.current.press());
      await act(() => result.current.goTo(home));
      expect(result.current.picker).toEqual({ mode: 'failed', apps: [expect.objectContaining({ id: 'google_maps' })], missingLabel: 'Maps' });
    });
  });
});
