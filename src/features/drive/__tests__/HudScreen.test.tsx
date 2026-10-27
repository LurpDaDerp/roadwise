import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { AppState, Platform, StyleSheet, View } from 'react-native';

import { createFakeDriveSense } from '@drive-sense';

import { T0 as DRIVE_T0 } from '@/core/detectors/__fixtures__/rows';
import { rows as driveRows, TZ as DRIVE_TZ } from '@/core/engine/__fixtures__/drives';
import { createDriveHost, type DriveState, type LastFinalized } from '@/drive/host';
import type { DriveBearing, DriveLive, ShownSpeed } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { DIM_AFTER_MS, END_SWIPE_H_PT, HUD, HUD_MIN_TARGET_PT, speedingTint, type HaloProps, type HaloVisual } from '@/ui/drive';
import { skyBundle, type SkyMood } from '@/ui/sky/palette';
import { ThemeProvider, useTheme, type Theme } from '@/ui/theme';

import { clearHomeNotice, readHomeNotice } from '@/features/home/homeNotice';

import { hudCopy } from '../hudCopy';
import { hudLayout } from '../hudLayout';
import { driveScreenEnteredFor, isDriveScreenFocused, resetDriveScreenPresence } from '../hudPresence';
import { HudScreen, hudNightOf } from '../HudScreen';
import { WEATHER_CLOSE_PT, weatherBannerPt } from '../WeatherBanner';

// The halo renders for real; its props are kept so a test can read the visual it was given.
const mockHalo: HaloProps[] = [];
jest.mock('@/ui/drive/HaloRing', () => {
  const actual = jest.requireActual('@/ui/drive/HaloRing');
  return {
    ...actual,
    Halo: (props: HaloProps) => {
      mockHalo.push(props);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the mock factory
      return require('react').createElement(actual.Halo, props);
    },
  };
});
// The OS reduce-motion setting, as the screen reads it.
let mockStill = false;
jest.mock('@/ui/theme', () => ({ ...jest.requireActual('@/ui/theme'), useOsReduceMotion: () => mockStill }));

const mockRouter = { replace: jest.fn(), push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
/** The route's focus: focused unless a test blurs it (then re-renders). */
let mockFocused = true;
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  // The screen's focus, as an effect that runs while the route is focused (its cleanup is the blur).
  useFocusEffect: (fn: () => void | (() => void)) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the mock factory
    require('react').useEffect(() => (mockFocused ? fn() : undefined), [fn, mockFocused]),
}));
/** The phone's heading subscriptions (expo-location `watchHeadingAsync`), newest last. */
type MockHeadingSub = { emit(h: { trueHeading: number; magHeading: number; accuracy: number }): void; fail(): void; removed: boolean };
const mockHeadingSubs: MockHeadingSub[] = [];
/** expo-location's `watchHeadingAsync`, as the fake phone answers it (set again before each test). */
async function mockWatchHeading(cb: (h: unknown) => void, onError?: (reason: string) => void): Promise<{ remove(): void }> {
  const sub: MockHeadingSub = {
    emit: (h) => {
      if (!sub.removed) cb(h);
    },
    fail: () => onError?.('heading unavailable'),
    removed: false,
  };
  mockHeadingSubs.push(sub);
  return {
    remove: () => {
      sub.removed = true;
    },
  };
}
jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: jest.fn(async () => null),
  watchHeadingAsync: jest.fn((cb: (h: unknown) => void, onError?: (reason: string) => void) => mockWatchHeading(cb, onError)),
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

/** The End swipe, carried all the way (a screen reader's activate: the drag itself is `SwipeButton`'s test). */
async function swipeEnd(end = screen.getByRole('button', { name: hudCopy.endLabel })) {
  await fireEvent(end, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
}

// The local settings mirror: `units` as WP9 writes it.
let mockUnits: 'mi' | 'km' | null = null;
// The saved navigation app (`navigation.app`), or null.
let mockNavApp: string | null = null;
const mockDb = {
  execute: jest.fn(async (_sql: string, params: unknown[]) => ({
    rows:
      params[0] === 'units' && mockUnits !== null
        ? [{ value_json: JSON.stringify(mockUnits) }]
        : params[0] === 'navigation.app' && mockNavApp !== null
          ? [{ value_json: JSON.stringify(mockNavApp) }]
          : [],
  })),
};
jest.mock('@/data/queries/context', () => ({ useDb: () => mockDb, useOptionalDb: () => mockDb }));

const T = 1_790_000_000_000;
const MPS_PER_MPH = 0.44704;
let mockLive: DriveLive;
/** The halo's number as the store hands it to the readout (`useShownSpeed`). */
let mockShown: ShownSpeed = { mps: null, accel: 0, at: null };
const mockEnd = jest.fn<Promise<{ clientTripId: string; dropped: 'no_movement' | 'no_gps' | 'cancelled' | null } | null>, []>();
let mockLastFinalized: LastFinalized = null;
/** The drive's controls as the screen calls them (stable, as the real hook's memo is). */
const mockControls = {
  start: jest.fn(),
  end: mockEnd,
  touchWaiting: jest.fn(),
  cancelWaiting: jest.fn(async () => {}),
  cancelDrive: jest.fn(async () => true),
  setHudVisible: jest.fn(),
  dismissWeather: jest.fn(),
};
/** The store's newest row time (the row clock), or null before any row. */
let mockLastRowTs: number | null = null;
/** The drive's start as the store has it (the navigation button's warm-up highlight). */
let mockStartedAt: number | null = null;
/** The engine's compass bearing (`useBearing`). */
let mockBearing: DriveBearing = { deg: null, source: null };
jest.mock('@/drive/useDrive', () => ({
  useBearing: () => mockBearing,
  useDrive: <T,>(sel: (s: { lastFinalized: LastFinalized; status: DriveLive['status']; startedAt: number | null; lastRowTs: number | null }) => T) =>
    sel({ lastFinalized: mockLastFinalized, status: mockLive.status, startedAt: mockStartedAt, lastRowTs: mockLastRowTs }),
  useDriveLive: () => mockLive,
  useShownSpeed: () => mockShown,
  useDriveControls: () => mockControls,
  useDriveHost: () => ({ snapshot: () => ({ lastFinalized: mockLastFinalized, status: mockLive.status, waiting: mockLive.waiting }) }),
}));

const p = HUD.day;
/** The halo ring is hidden from assistive tech, so queries for it must ask for hidden elements. */
const HIDDEN = { includeHiddenElements: true };
/** What the halo was last told to show. */
const halo = (): HaloVisual => mockHalo.at(-1)!.visual;

/**
 * A test's view of the drive: `speedMph` is both the newest row's GPS speed (the halo's speeding
 * hold) and the speed the readout shows, standing for `speedAt` (the clock now when not given),
 * carried on with `speedAccelMph` (mph/s). `speedingRatio` (the speed shown over the limit the sign
 * shows) is handed to the screen as the store hands it: its tint and whether it is over the sign.
 */
type LiveOver = Partial<DriveLive> & { speedMph?: number | null; speedAccelMph?: number; speedAt?: number | null; speedingRatio?: number | null };

let lastShown: { speedMph: number | null; speedAccelMph: number; speedAt: number | null } = { speedMph: 34, speedAccelMph: 0, speedAt: null };

function split(over: LiveOver, base: typeof lastShown): { live: Partial<DriveLive>; shown: typeof lastShown } {
  const { speedMph, speedAccelMph, speedAt, speedingRatio, ...given } = over;
  const rest: Partial<DriveLive> =
    speedingRatio === undefined ? given : { speedingTint: speedingTint(speedingRatio), overSign: speedingRatio !== null && speedingRatio > 1, ...given };
  const shown = {
    speedMph: speedMph === undefined ? base.speedMph : speedMph,
    speedAccelMph: speedAccelMph ?? (speedMph === undefined ? base.speedAccelMph : 0),
    speedAt: speedAt !== undefined ? speedAt : speedMph === undefined && speedAccelMph === undefined ? base.speedAt : Date.now(),
  };
  const liveOver: Partial<DriveLive> = speedMph === undefined ? rest : { rowSpeedMph: speedMph, ...rest };
  return { live: liveOver, shown };
}

function setShown(s: typeof lastShown): void {
  lastShown = s;
  mockShown =
    s.speedMph === null
      ? { mps: null, accel: 0, at: null }
      : { mps: s.speedMph * MPS_PER_MPH, accel: s.speedAccelMph * MPS_PER_MPH, at: s.speedAt };
}

/** The speed a test drives at unless it says (End locks at 20 mph, so its tests run slower). */
let mockDefaultMph = 34;

function live(over: Partial<DriveLive> = {}): DriveLive {
  return {
    status: 'recording',
    clientTripId: 't1',
    rowSpeedMph: mockDefaultMph,
    limitMph: 35,
    speedingTint: 0,
    overSign: false,
    speedingOver: false,
    lastShake: null,
    lastAlert: null,
    weatherAlert: null,
    rowTs: null,
    waiting: null,
    notDrivingAvailable: false,
    spotNudge: null,
    ...over,
  };
}

async function renderHud(over: LiveOver = {}) {
  const first = split(over, { speedMph: mockDefaultMph, speedAccelMph: 0, speedAt: Date.now() });
  setShown(first.shown);
  mockLive = live(first.live);
  const r = await render(<HudScreen />);
  await act(async () => {}); // the units read
  return {
    async update(next: LiveOver) {
      const s = split(next, lastShown);
      setShown(s.shown);
      mockLive = { ...mockLive, ...s.live };
      await r.rerender(<HudScreen />);
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  jest.clearAllMocks();
  mockHalo.length = 0;
  setShown({ speedMph: 34, speedAccelMph: 0, speedAt: T });
  mockStill = false;
  mockUnits = null;
  mockNavApp = null;
  mockLastRowTs = null;
  mockStartedAt = T;
  mockLastFinalized = null;
  mockDefaultMph = 34;
  mockEnd.mockResolvedValue({ clientTripId: 't1', dropped: null });
  mockControls.cancelDrive.mockResolvedValue(true);
  mockBearing = { deg: null, source: null };
  mockFocused = true;
  mockHeadingSubs.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module
  (require('expo-location') as { watchHeadingAsync: jest.Mock }).watchHeadingAsync.mockImplementation(mockWatchHeading);
  resetDriveScreenPresence();
  clearHomeNotice();
});
afterEach(() => jest.useRealTimers());

describe('speed and limit', () => {
  test('the speed sits inside the halo; the limit on its sign', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('34');
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
  });

  test('miles by default and when the mirror says mi', async () => {
    mockUnits = 'mi';
    await renderHud();
    expect(screen.getByText('mph')).toBeTruthy();
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
  });

  test('km: the speed and the limit sign are converted to whole km/h', async () => {
    mockUnits = 'km';
    await renderHud({ speedMph: 34, limitMph: 35 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('55');
    expect(screen.getByText('km/h')).toBeTruthy();
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('56');
  });

  test('km: an unknown limit is still "-"', async () => {
    mockUnits = 'km';
    await renderHud({ limitMph: null });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('-');
  });

  test('cruising, the speed moves on with each fix and holds still between fixes', async () => {
    const h = await renderHud({ speedMph: 40 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('40');
    await act(() => jest.advanceTimersByTime(900));
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('40');
    await h.update({ speedMph: 33 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('33');
  });

  test('a new number crossfades the digits that change, as the lock screen does; under Reduce Motion it swaps at once', async () => {
    const h = await renderHud({ speedMph: 40 });
    expect(screen.queryByTestId('hud-speed-fading')).toBeNull();
    await h.update({ speedMph: 43 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('43');
    expect(screen.getAllByTestId('hud-speed-digit-out').map((d) => d.props.children)).toEqual(['0']);
    await screen.unmount();
    mockStill = true;
    const still = await renderHud({ speedMph: 40 });
    await still.update({ speedMph: 43 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('43');
    expect(screen.queryByTestId('hud-speed-fading')).toBeNull();
  });

  test("speeding up or slowing, it moves on 4 times a second along the acceleration from the fix's own time, for at most 1.5 s", async () => {
    // A fix 250 ms old as it lands: 40 mph, slowing 3 mph/s. 39.25 at once, then 38.5, 37.75, 37,
    // 36.25 and 35.5 every 250 ms, held at 35.5 past 1.5 s; whole numbers move 0.8 past the last one.
    const h = await renderHud({ speedMph: 40, speedAccelMph: -3, speedAt: T - 250 });
    const shown = () => screen.getByTestId('hud-speed-numeral');
    expect(shown()).toHaveTextContent('39');
    await act(() => jest.advanceTimersByTime(250));
    expect(shown()).toHaveTextContent('39');
    await act(() => jest.advanceTimersByTime(250));
    expect(shown()).toHaveTextContent('38');
    await act(() => jest.advanceTimersByTime(250));
    expect(shown()).toHaveTextContent('37');
    // 36.25 is not yet 0.8 past 37…
    await act(() => jest.advanceTimersByTime(250));
    expect(shown()).toHaveTextContent('37');
    // …35.5 is, and the carry stops there, 1.5 s after the fix.
    await act(() => jest.advanceTimersByTime(250));
    expect(shown()).toHaveTextContent('36');
    await act(() => jest.advanceTimersByTime(1000));
    expect(shown()).toHaveTextContent('36');
    // The next fix starts again from its own estimate.
    await h.update({ speedMph: 37.4, speedAccelMph: 0 });
    expect(shown()).toHaveTextContent('37');
    await act(() => jest.advanceTimersByTime(700));
    expect(shown()).toHaveTextContent('37');
  });

  test('in the background it never ticks; with Control Center over the screen (inactive) it keeps moving on', async () => {
    const app = appStateListeners();
    try {
      await renderHud({ speedMph: 40, speedAccelMph: -3, speedAt: T - 250 });
      const shown = () => screen.getByTestId('hud-speed-numeral');
      expect(shown()).toHaveTextContent('39');
      await app.set('background');
      await act(() => jest.advanceTimersByTime(750));
      // 37.75 by now on screen, but nobody is looking: the readout holds what it showed last
      expect(shown()).toHaveTextContent('39');
      // in front again (an overlay over the screen counts): where the carry stands now, 37, then on
      await app.set('inactive');
      expect(shown()).toHaveTextContent('37');
      await act(() => jest.advanceTimersByTime(500));
      expect(shown()).toHaveTextContent('36');
    } finally {
      app.restore();
    }
  });

  test('a speed sitting near x.5 does not flicker: the whole number moves only 0.3 past the half', async () => {
    const h = await renderHud({ speedMph: 34.6 });
    const shown = () => screen.getByTestId('hud-speed-numeral');
    expect(shown()).toHaveTextContent('35');
    await h.update({ speedMph: 34.4 });
    expect(shown()).toHaveTextContent('35');
    await h.update({ speedMph: 34.7 });
    expect(shown()).toHaveTextContent('35');
    await h.update({ speedMph: 34.15 });
    expect(shown()).toHaveTextContent('34');
  });

  test('an unknown speed or limit is "-"', async () => {
    await renderHud({ speedMph: null, limitMph: null });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('-');
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('-');
  });
});

describe('the halo while speeding', () => {
  // limit 35: the speeding line at 39 (T 4); the tint full red at 1.7 x 35 = 59.5; one row per second
  const at = (mph: number, line = 39, limit = 35) => ({ speedMph: mph, speedingRatio: mph / limit, speedingOver: mph > line });

  test('within the limit: calm, flowing, the speed white', async () => {
    await renderHud({ rowTs: T });
    expect(halo()).toMatchObject({ mode: 'calm', flow: true, pulsePeriodMs: 0 });
    // the numerals take the halo's colour at severity 0: the halo white (#F3F6FB), through Reanimated
    expect(p.haloInk).toBe('#F3F6FB');
    expect(JSON.stringify(screen.getAllByTestId('hud-speed-digit')[0]!.props.style)).toMatch(/rgba\(243, 246(\.\d+)?, 251, 1\)/);
    expect(screen.getByTestId('hud-halo', HIDDEN)).toBeTruthy();
  });

  test('past the limit, under the speeding line: a faint tint from the limit, still flowing, no pulse; spoken "over the limit"', async () => {
    await renderHud({ rowTs: T, ...at(37) });
    expect(halo()).toMatchObject({ mode: 'speeding', flow: true, pulsePeriodMs: 0, warning: false });
    expect(halo().colorSeverity).toBeCloseTo((37 / 35 - 1) / 0.7, 9);
    expect(screen.getByLabelText(/over the limit/)).toBeTruthy();
  });

  test.each([
    [40, (40 / 35 - 1) / 0.7],
    [45, (45 / 35 - 1) / 0.7],
    [52, (52 / 35 - 1) / 0.7],
    [70, 1],
  ])('over the speeding line at %s mph: tinted %s from the limit, pulsing, no flow', async (mph, s) => {
    await renderHud({ rowTs: T, ...at(mph) });
    expect(halo().mode).toBe('speeding');
    expect(halo().severity).toBeCloseTo(s, 9);
    expect(halo().flow).toBe(false);
    expect(halo().pulsePeriodMs).toBeCloseTo(2200 - 1400 * s, 6);
  });

  test('the pulse stops on the first row back under the speeding line; the tint follows each row, calm at the limit', async () => {
    const h = await renderHud({ rowTs: T, ...at(47) });
    expect(halo().pulsePeriodMs).toBeGreaterThan(0);
    await h.update({ rowTs: T + 1000, ...at(38) });
    expect(halo()).toMatchObject({ mode: 'speeding', pulsePeriodMs: 0, flow: true });
    expect(halo().colorSeverity).toBeCloseTo((38 / 35 - 1) / 0.7, 9);
    await h.update({ rowTs: T + 2000, ...at(34) });
    expect(halo().mode).toBe('calm');
    expect(screen.queryByLabelText(/over the limit/)).toBeNull();
  });

  test('no usable limit (a class default, a ramp): no tint and no pulse, whatever the sign shows', async () => {
    await renderHud({ rowTs: T, speedMph: 60, limitMph: 25, speedingRatio: null, speedingOver: false });
    expect(halo().mode).toBe('calm');
  });

  test('hovering at the line (39.1 / 38.9): the pulse comes and goes with the row, the colour barely moves; the scrim dims under a tint alone', async () => {
    const h = await renderHud({ rowTs: T - 1000, ...at(30) });
    const tints: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      await h.update({ rowTs: T + i * 1000, ...at(i % 2 === 0 ? 39.1 : 38.9) });
      tints.push(halo().colorSeverity);
      expect(halo().pulsePeriodMs > 0).toBe(i % 2 === 0);
      expect(halo().warning).toBe(i % 2 === 0);
    }
    expect(Math.max(...tints) - Math.min(...tints)).toBeLessThan(0.01);
    await h.update({ rowTs: T + 20_000, ...at(37) });
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS));
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
    expect(mockHalo.at(-1)!.dimmed).toBe(true);
    expect(halo().warning).toBe(false);
  });

  test('a speed with three digits takes the three-digit size', async () => {
    mockUnits = 'km';
    const h = await renderHud({ speedMph: 55 });
    const two = Number(screen.getAllByTestId('hud-speed-digit')[0]!.props.style.flat?.(9).find((x: { fontSize?: number }) => x?.fontSize)?.fontSize ?? 0);
    await h.update({ speedMph: 70 }); // 113 km/h
    const three = Number(screen.getAllByTestId('hud-speed-digit')[0]!.props.style.flat?.(9).find((x: { fontSize?: number }) => x?.fontSize)?.fontSize ?? 0);
    expect(three).toBeGreaterThan(0);
    expect(three).toBeLessThan(two);
  });
});

describe('the shake on an event', () => {
  const ev = (key: string, tier: 'minor' | 'moderate' | 'severe', atTs: number) => ({ key, tier, at: atTs });

  test('each new event shakes the ring once with its tier; the same one again does not', async () => {
    const h = await renderHud({ rowTs: T });
    expect(halo().shake).toBeNull();
    await h.update({ rowTs: T + 1000, lastShake: ev('hard_brake:1', 'severe', T + 1000) });
    expect(halo().shake).toEqual({ key: `hard_brake:1@${T + 1000}`, tier: 'severe' });
    await h.update({ rowTs: T + 1000, lastShake: ev('hard_brake:1', 'severe', T + 1000) });
    expect(halo().shake).toEqual({ key: `hard_brake:1@${T + 1000}`, tier: 'severe' });
    await act(() => jest.advanceTimersByTime(1500));
    expect(halo().shake).toBeNull();
    await h.update({ rowTs: T + 9000, lastShake: ev('speeding:2:grace', 'minor', T + 9000) });
    expect(halo().shake).toEqual({ key: `speeding:2:grace@${T + 9000}`, tier: 'minor' });
  });

  test('never for the one standing when the screen opens, nor for one 1.5 s old on the row clock (it happened in the background)', async () => {
    const h = await renderHud({ rowTs: T, lastShake: ev('hard_brake:1', 'severe', T) });
    expect(halo().shake).toBeNull();
    await h.update({ rowTs: T + 6000, lastShake: ev('hard_corner:2', 'moderate', T + 1000) });
    expect(halo().shake).toBeNull();
  });

  test('none under Reduce Motion', async () => {
    mockStill = true;
    const h = await renderHud({ rowTs: T });
    await h.update({ rowTs: T + 1000, lastShake: ev('hard_brake:1', 'severe', T + 1000) });
    expect(halo().shake).toBeNull();
  });
});

/** Every AppState listener the screen adds (its own and the halo burst's), and a way to flip the state for all. */
function appStateListeners(): { set(state: string): Promise<void>; restore(): void } {
  const fns: ((s: string) => void)[] = [];
  // Swapped by hand, not spied: restoring a spy on the preset's own mock would leave it answering nothing.
  const original = AppState.addEventListener;
  const target = AppState as unknown as { addEventListener: unknown };
  target.addEventListener = (_e: string, fn: (s: string) => void) => {
    fns.push(fn);
    return {
      remove: () => {
        const i = fns.indexOf(fn);
        if (i >= 0) fns.splice(i, 1);
      },
    };
  };
  return {
    set: async (state) => {
      await act(async () => {
        for (const fn of [...fns]) fn(state);
      });
    },
    restore: () => {
      target.addEventListener = original;
    },
  };
}

describe('the compass (round 8 decision 7)', () => {
  const heading = () => mockHalo.at(-1)!.heading;
  const subs = () => mockHeadingSubs;
  const open = () => mockHeadingSubs.filter((x) => !x.removed);
  /** The phone's compass says `deg` (true north), well calibrated. */
  const phone = async (deg: number) => {
    await act(async () => open().at(-1)!.emit({ trueHeading: deg, magHeading: deg, accuracy: 3 }));
  };
  const track = (deg: number): DriveBearing => ({ deg, source: 'track' });
  /** The subscription is asked for after a microtask: let it land. */
  const settle = () => act(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
  const dims = () => require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
  const landscapeWindow = () => jest.spyOn(dims(), 'default').mockReturnValue({ width: 844, height: 390, scale: 3, fontScale: 1 });

  test('before any heading: north-up with its letters dimmed (the GPS course alone never turns it)', async () => {
    const h = await renderHud({ rowTs: T });
    expect(heading()).toBeNull();
    expect(screen.getByTestId('hud-compass', HIDDEN)).toBeTruthy();
    await h.update({ rowTs: T + 1000 });
    expect(heading()).toBeNull();
  });

  test("before the drive's first track bearing it follows the phone's heading (true north, else magnetic)", async () => {
    await renderHud({ rowTs: T });
    expect(subs()).toHaveLength(1);
    await phone(80);
    expect(heading()).toBe(80);
    // no true heading (-1): the magnetic one
    await act(async () => open().at(-1)!.emit({ trueHeading: -1, magHeading: 120, accuracy: 2 }));
    await act(() => jest.advanceTimersByTime(3000));
    expect(heading()).toBe(120);
    // an uncalibrated reading is passed over
    await act(async () => open().at(-1)!.emit({ trueHeading: 300, magHeading: 300, accuracy: 0 }));
    await act(() => jest.advanceTimersByTime(3000));
    expect(heading()).toBe(120);
  });

  test("smoothed: a jittering phone doesn't turn the card on every reading; a real turn is followed to where the phone points", async () => {
    await renderHud({ rowTs: T });
    await phone(90);
    const before = mockHalo.length;
    // ±2° of noise around 90, faster than the ticks
    for (const d of [92, 88, 91, 89, 92, 88]) {
      await phone(d);
      await act(() => jest.advanceTimersByTime(100));
    }
    const shown = mockHalo.slice(before).map((x) => x.heading as number);
    expect(shown.every((x) => Math.abs(x - 90) < 3)).toBe(true);
    expect(new Set(shown).size).toBeLessThanOrEqual(2);
    await phone(180);
    await act(() => jest.advanceTimersByTime(250));
    expect(heading()).toBeGreaterThan(95);
    expect(heading()).toBeLessThan(180);
    await act(() => jest.advanceTimersByTime(5000));
    expect(heading()).toBe(180);
  });

  test('the track bearing takes over at once, the phone is let go, and the drive never goes back to it', async () => {
    const h = await renderHud({ rowTs: T });
    await phone(10);
    expect(heading()).toBe(10);
    mockBearing = track(200);
    await h.update({ rowTs: T + 1000 });
    expect(heading()).toBe(200);
    expect(subs().every((x) => x.removed)).toBe(true);
    // the engine's bearing moves on
    mockBearing = track(215.5);
    await h.update({ rowTs: T + 2000 });
    expect(heading()).toBe(215.5);
    // even were the bearing lost, the drive keeps its last one and never asks the phone again
    mockBearing = { deg: null, source: null };
    await h.update({ rowTs: T + 3000 });
    expect(heading()).toBe(215.5);
    await act(() => jest.advanceTimersByTime(5000));
    expect(subs()).toHaveLength(1);
    expect(heading()).toBe(215.5);
    // the drive's end (its id cleared) keeps it too, while the screen saves
    await h.update({ rowTs: T + 4000, status: 'finalizing', clientTripId: null });
    expect(heading()).toBe(215.5);
  });

  test("a new drive on the same screen starts from the phone's heading again", async () => {
    const h = await renderHud({ rowTs: T });
    mockBearing = track(45);
    await h.update({ rowTs: T + 1000 });
    expect(heading()).toBe(45);
    mockBearing = { deg: null, source: null };
    await h.update({ rowTs: T + 2000, clientTripId: 't2' });
    await settle();
    expect(heading()).toBeNull();
    expect(open()).toHaveLength(1);
    await phone(300);
    expect(heading()).toBe(300);
  });

  test('a track bearing from the first render: the phone is never asked', async () => {
    mockBearing = track(90);
    await renderHud({ rowTs: T });
    expect(heading()).toBe(90);
    await act(() => jest.advanceTimersByTime(1000));
    expect(subs()).toHaveLength(0);
  });

  test('landscape: the dimmed north-up card until a track bearing (the phone is not asked)', async () => {
    const wide = landscapeWindow();
    const h = await renderHud({ rowTs: T });
    expect(screen.getByTestId('hud-compass', HIDDEN)).toBeTruthy();
    expect(subs()).toHaveLength(0);
    expect(heading()).toBeNull();
    mockBearing = track(135);
    await h.update({ rowTs: T + 1000 });
    expect(heading()).toBe(135);
    wide.mockRestore();
  });

  test('turning to landscape lets the phone go (north-up, dimmed); back in portrait it is asked again', async () => {
    // the window hook stays the same one all along (a swapped hook would change the hook order)
    let win = { width: 393, height: 852, scale: 3, fontScale: 1 };
    const spy = jest.spyOn(dims(), 'default').mockImplementation(() => win);
    const h = await renderHud({ rowTs: T });
    await phone(60);
    expect(heading()).toBe(60);
    win = { width: 852, height: 393, scale: 3, fontScale: 1 };
    await h.update({ rowTs: T + 1000 });
    expect(subs().every((x) => x.removed)).toBe(true);
    expect(heading()).toBeNull();
    win = { width: 393, height: 852, scale: 3, fontScale: 1 };
    await h.update({ rowTs: T + 2000 });
    await settle();
    expect(open()).toHaveLength(1);
    spy.mockRestore();
  });

  test('only while the screen is focused with RoadWise in front', async () => {
    const app = appStateListeners();
    const h = await renderHud({ rowTs: T });
    expect(open()).toHaveLength(1);
    await phone(30);
    await app.set('background');
    expect(open()).toHaveLength(0);
    expect(heading()).toBeNull();
    await app.set('active');
    await settle();
    expect(open()).toHaveLength(1);
    // blurred (another route over it): let go; focused again: asked again
    mockFocused = false;
    await h.update({ rowTs: T + 1000 });
    expect(open()).toHaveLength(0);
    mockFocused = true;
    await h.update({ rowTs: T + 2000 });
    await settle();
    expect(open()).toHaveLength(1);
    expect(subs()).toHaveLength(3);
    app.restore();
  });

  test('Control Center, a call banner or Siri over the screen (inactive) keeps following the phone', async () => {
    const app = appStateListeners();
    try {
      await renderHud({ rowTs: T });
      await phone(30);
      expect(heading()).toBe(30);
      await app.set('inactive');
      expect(open()).toHaveLength(1);
      expect(heading()).toBe(30);
      await phone(90);
      await act(() => jest.advanceTimersByTime(5000));
      expect(heading()).toBe(90);
      await app.set('active');
      expect(subs()).toHaveLength(1);
      expect(heading()).toBe(90);
    } finally {
      app.restore();
    }
  });

  test('not while idle; let go on unmount', async () => {
    const h = await renderHud({ status: 'idle', rowTs: T });
    expect(subs()).toHaveLength(0);
    await h.update({ status: 'recording' });
    await settle();
    expect(open()).toHaveLength(1);
    await screen.unmount();
    expect(open()).toHaveLength(0);
  });

  test('a refused permission (or no compass) is silent: dimmed north-up', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module
    const Location = require('expo-location') as { watchHeadingAsync: jest.Mock };
    Location.watchHeadingAsync.mockRejectedValueOnce(new Error('Location permission not granted'));
    await renderHud({ rowTs: T });
    await act(async () => {});
    expect(Location.watchHeadingAsync).toHaveBeenCalledTimes(1);
    expect(heading()).toBeNull();
  });

  test('a heading stream that fails mid-drive goes back to dimmed north-up', async () => {
    await renderHud({ rowTs: T });
    await phone(250);
    expect(heading()).toBe(250);
    await act(async () => open().at(-1)!.fail());
    expect(heading()).toBeNull();
  });

  test('Android keeps the dimmed north-up card until a track bearing (its compass is never asked)', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const h = await renderHud({ rowTs: T });
    expect(subs()).toHaveLength(0);
    expect(heading()).toBeNull();
    mockBearing = track(10);
    await h.update({ rowTs: T + 1000 });
    expect(heading()).toBe(10);
    os.restore();
  });

  test('none in a compact window (no ring)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
    const dims = require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
    jest.spyOn(dims, 'default').mockReturnValue({ width: 400, height: 300, scale: 2, fontScale: 1 });
    await renderHud();
    expect(screen.queryByTestId('hud-compass', HIDDEN)).toBeNull();
    jest.restoreAllMocks();
  });
});

describe('the dangerous-weather banner (plan D14)', () => {
  const ICE = { kind: 'freezing_rain', gustMph: null, visibilityM: null } as const;
  const GUSTS = { kind: 'strong_wind', gustMph: 52, visibilityM: null } as const;

  test('only while an alert is active: a yellow outline, the warning glyph in yellow, the title and the warning; the line is spoken', async () => {
    const h = await renderHud();
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    await h.update({ weatherAlert: ICE });
    expect(screen.getByTestId('hud-weather')).toHaveTextContent(/Freezing rain/);
    expect(screen.getByTestId('hud-weather')).toHaveStyle({ borderColor: p.minor, backgroundColor: p.chrome });
    expect(screen.getByTestId('hud-weather-icon', HIDDEN)).toHaveStyle({ color: p.minor });
    expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Weather alert. Freezing rain. Rain is freezing on the road. Slow down, brake gently.');
    // Under the title, the warning in quiet print, one line, fixed size; the full line is only spoken.
    const action = screen.getByTestId('hud-weather-action');
    expect(action).toHaveTextContent('Slow down, brake gently');
    expect(action).toHaveStyle({ color: p.inkMuted, fontSize: 15 });
    expect(action).toHaveProp('allowFontScaling', false);
    expect(action).toHaveProp('numberOfLines', 1);
    expect(screen.queryByText(/Rain is freezing/)).toBeNull();
    expect(screen.getByText('Freezing rain').props.children.split(' ').length).toBeLessThanOrEqual(3);
    await h.update({ weatherAlert: null });
    expect(screen.queryByTestId('hud-weather')).toBeNull();
  });

  test('the HUD warning yellow holds AAA on the banner in both palettes', async () => {
    const { contrastRatio } = jest.requireActual<typeof import('@/ui/contrast')>('@/ui/contrast');
    for (const pal of [HUD.day, HUD.night]) {
      expect(contrastRatio(pal.minor, pal.chrome)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(pal.ink, pal.chrome)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(pal.inkMuted, pal.chrome)).toBeGreaterThanOrEqual(7);
    }
  });

  test('its two lines and the ✕ fit the top band, full (56 pt) and compact (40 pt), so it never reaches the halo or the row', () => {
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    const full = hudLayout({ width: 375, height: 667, insets, fontScale: 1, chip: false, units: 'mi' });
    const compact = hudLayout({ width: 400, height: 300, insets, fontScale: 1, chip: false, units: 'mi' });
    expect(full.compact).toBe(false);
    expect(compact.compact).toBe(true);
    expect(weatherBannerPt(false)).toBeLessThanOrEqual(full.line.h);
    expect(weatherBannerPt(true)).toBeLessThanOrEqual(compact.line.h);
    // The ✕'s disc sits inside the banner's outline at its smallest.
    expect(WEATHER_CLOSE_PT).toBeLessThanOrEqual(weatherBannerPt(true) - 4);
  });

  test('a compact window takes the smaller type', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
    const dims = require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
    jest.spyOn(dims, 'default').mockReturnValue({ width: 400, height: 300, scale: 2, fontScale: 1 });
    await renderHud({ weatherAlert: ICE, speedMph: 60 });
    expect(screen.getByTestId('hud-weather-action')).toHaveStyle({ fontSize: 13 });
    expect(screen.getByTestId('hud-weather-close')).toBeOnTheScreen();
    expect(screen.getByText('Freezing rain')).toHaveStyle({ fontSize: 16 });
    jest.restoreAllMocks();
  });

  test('gusts in the driver units, spoken', async () => {
    mockUnits = 'km';
    await renderHud({ weatherAlert: GUSTS });
    expect(screen.getByTestId('hud-weather')).toHaveTextContent(/Strong winds/);
    expect(screen.getByTestId('hud-weather-action')).toHaveTextContent('Hands on the wheel');
    expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Weather alert. Strong winds. Gusts to 84 km/h. Keep both hands on the wheel.');
  });

  test('the ✕ shows and works at any speed: it asks the host to hide it for the rest of the drive', async () => {
    const h = await renderHud({ weatherAlert: ICE, speedMph: 3 });
    expect(screen.getByRole('button', { name: 'Hide weather alert' })).toBeOnTheScreen();
    await h.update({ speedMph: 70 });
    const close = screen.getByRole('button', { name: 'Hide weather alert' });
    expect(close).not.toBeDisabled();
    expect(close).toHaveProp('accessibilityHint', 'Hides it for the rest of this drive.');
    // The drawn disc is small, the touch target is the HUD's 64 pt.
    const slop = close.props.hitSlop as number;
    expect(34 + 2 * slop).toBeGreaterThanOrEqual(HUD_MIN_TARGET_PT);
    await act(async () => {
      fireEvent.press(close);
    });
    expect(mockControls.dismissWeather).toHaveBeenCalledTimes(1);
    // The host leaves the dismissed kind out from then on.
    await h.update({ weatherAlert: null });
    expect(screen.queryByTestId('hud-weather')).toBeNull();
  });

  test('an event banner still takes the band for its 1.5 s', async () => {
    const h = await renderHud({ weatherAlert: ICE, rowTs: T });
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    await act(() => jest.advanceTimersByTime(1500));
    expect(screen.getByTestId('hud-weather')).toBeTruthy();
  });
});

describe('event alerts', () => {
  test('a hard brake: its words for 1.5 s and a red burst of three pulses, then calm again', async () => {
    const h = await renderHud({ rowTs: T });
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toHaveTextContent(/Hard brake/);
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: { key: `event:hard_brake:${T + 1000}`, pulses: 3 } });
    await act(() => jest.advanceTimersByTime(1499));
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    await act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(halo().mode).toBe('calm');
  });

  test('a speeding alert says "Slow down" but never bursts', async () => {
    const h = await renderHud({ rowTs: T });
    await h.update({
      rowTs: T + 1000,
      speedMph: 41,
      speedingRatio: 41 / 35,
      speedingOver: true,
      lastAlert: { type: 'speeding', tier: 'minor', at: T + 1000 },
    });
    expect(screen.getByTestId('hud-alert')).toHaveTextContent(/Slow down/);
    expect(screen.getByTestId('hud-alert')).not.toHaveTextContent(/Speeding/);
    expect(halo().mode).toBe('speeding');
    expect(halo().burst).toBeNull();
  });

  test('the alert already standing when the screen opens is not replayed, and never bursts', async () => {
    await renderHud({ rowTs: T, lastAlert: { type: 'hard_brake', tier: 'minor', at: T } });
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(halo().mode).toBe('calm');
  });

  test('an alert raised while RoadWise was in the background (5 s old on the row clock) never shows or bursts', async () => {
    const h = await renderHud({ rowTs: T });
    await h.update({ rowTs: T + 6000, lastAlert: { type: 'hard_corner', tier: 'minor', at: T + 1000 } });
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(halo().mode).toBe('calm');
  });

  test('every alert is at most three words', () => {
    for (const words of Object.values(hudCopy.alert)) {
      expect(words.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    }
  });
});

test('no points anywhere on the screen, stopped or moving', async () => {
  const h = await renderHud({ speedMph: 30 });
  await h.update({ speedMph: 0 });
  expect(screen.queryByTestId('hud-points')).toBeNull();
  expect(screen.queryByText(/\bpts\b|points?/)).toBeNull();
});

describe('swipe to end', () => {
  // Slow enough for End (it locks at 20 mph).
  beforeEach(() => {
    mockDefaultMph = 8;
  });

  test('a tap, or a swipe let go short of the end, does nothing: the drive goes on', async () => {
    await renderHud();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await fireEvent(end, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: END_SWIPE_H_PT } } });
    await fireEvent.press(end).catch(() => {});
    await act(() =>
      fireGestureHandler(getByGestureTestId('hud-end-pan'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 120 },
        { state: State.END, translationX: 120 },
      ])
    );
    await act(() => jest.advanceTimersByTime(2000));
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('a swipe all the way ends the drive', async () => {
    await renderHud();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await fireEvent(end, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: END_SWIPE_H_PT } } });
    await act(() =>
      fireGestureHandler(getByGestureTestId('hud-end-pan'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 150 },
        { state: State.ACTIVE, translationX: 300 },
        { state: State.END, translationX: 300 },
      ])
    );
    await act(() => jest.advanceTimersByTime(20));
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test('End forgives a diagonal start: 24 pt up or down before the drag gives way (Home’s Start keeps 16)', async () => {
    await renderHud();
    const { config } = getByGestureTestId('hud-end-pan') as unknown as { config: { failOffsetYStart: number; failOffsetYEnd: number } };
    expect([config.failOffsetYStart, config.failOffsetYEnd]).toEqual([-24, 24]);
  });

  test('End is the layout’s 76 pt capsule across the foot of the screen', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-end')).toHaveStyle({ height: END_SWIPE_H_PT });
  });

  test('a full swipe ends the drive and lands on its fresh summary', async () => {
    await renderHud({ speedMph: 8 });
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await swipeEnd(end);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/drives/[clientTripId]',
      params: { clientTripId: 't1', fresh: '1' },
    });
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('with no drive to end it goes Home', async () => {
    mockEnd.mockResolvedValue(null);
    await renderHud({ status: 'idle', clientTripId: null });
    await swipeEnd();
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a drive that auto-ends lands on its summary once', async () => {
    const h = await renderHud();
    await h.update({ status: 'finalizing' });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  const drop = (clientTripId: string): LastFinalized => ({ clientTripId, ok: true, status: null, dropped: 'no_movement', endCause: 'stopped', at: T, durationS: null, miles: null });

  test('a drive that ended by itself and was not kept lands on Home once, not on a summary', async () => {
    const h = await renderHud();
    await h.update({ status: 'finalizing' });
    mockLastFinalized = drop('t1');
    await h.update({ status: 'idle', clientTripId: null });
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a hold that ends a drive that was not kept (or lands during its automatic drop) goes Home once', async () => {
    mockEnd.mockResolvedValue({ clientTripId: 't1', dropped: 'no_movement' });
    const h = await renderHud();
    await swipeEnd();
    mockLastFinalized = drop('t1');
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a dropped drive pops back to the Home already under the drive: dismissTo once, never replace', async () => {
    // replace would push a second tabs navigator over the first; dismissTo returns to it.
    mockEnd.mockResolvedValue({ clientTripId: 't1', dropped: 'no_gps' });
    await renderHud();
    await swipeEnd();
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('a hold that lands after the drive dropped itself, before this screen saw it go idle, goes Home', async () => {
    // The engine is already idle with this drive dropped (end() finds no drive), but the screen
    // still shows it recording, so the render-time drop id is stale.
    await renderHud();
    mockEnd.mockResolvedValue(null);
    mockLastFinalized = drop('t1');
    await swipeEnd();
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a hold that lands after the drive ended by itself and was kept goes to its summary', async () => {
    await renderHud();
    mockEnd.mockResolvedValue(null);
    mockLastFinalized = { clientTripId: 't1', ok: true, status: null, dropped: null, endCause: 'stopped', at: T, durationS: 600, miles: 4 };
    await swipeEnd();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('an older drive’s drop does not send this kept drive Home', async () => {
    mockLastFinalized = drop('old');
    const h = await renderHud();
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('a failed end says "Swipe again" and lets the driver swipe again', async () => {
    mockEnd.mockRejectedValueOnce(new Error('busy'));
    await renderHud();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await swipeEnd(end);
    expect(screen.getByTestId('hud-end-failed')).toHaveTextContent(hudCopy.endFailed);
    expect(hudCopy.endFailed.split(/\s+/).length).toBeLessThanOrEqual(3);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(end).not.toBeDisabled();

    await swipeEnd(end);
    expect(screen.queryByTestId('hud-end-failed')).toBeNull();
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
  });

  test('a drive that closed but could not be saved stays here with "Swipe again"; the next swipe saves it and opens its summary', async () => {
    const h = await renderHud();
    // End: the engine closes the drive, the finalize fails, and end() rejects.
    mockEnd.mockImplementationOnce(async () => {
      mockLastFinalized = { clientTripId: 't1', ok: false, at: T };
      throw new Error('drive t1 could not be finalized');
    });
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await swipeEnd(end);
    await h.update({ status: 'idle', clientTripId: null });
    expect(screen.getByTestId('hud-end-failed')).toHaveTextContent(hudCopy.endFailed);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(end).not.toBeDisabled();

    // The retry finalizes it.
    mockEnd.mockImplementationOnce(async () => {
      mockLastFinalized = { clientTripId: 't1', ok: true, status: 'pending', dropped: null, endCause: 'manual', at: T + 1, durationS: 600, miles: 4 };
      return { clientTripId: 't1', dropped: null };
    });
    await swipeEnd(end);
    expect(screen.queryByTestId('hud-end-failed')).toBeNull();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
  });

  test('a drive that ended by itself but could not be saved says "Swipe again" instead of opening a summary', async () => {
    const h = await renderHud();
    mockLastFinalized = { clientTripId: 't1', ok: false, at: T };
    await h.update({ status: 'idle', clientTripId: null });
    expect(screen.getByTestId('hud-end-failed')).toHaveTextContent(hudCopy.endFailed);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('while the drive is being saved, End is disabled', async () => {
    await renderHud({ status: 'finalizing' });
    expect(screen.getByRole('button', { name: hudCopy.endLabel })).toBeDisabled();
  });
});

describe('dimming', () => {
  test('dimmed and calm: the halo gets dimmed and keeps flowing; it sits above the scrim', async () => {
    await renderHud({ rowTs: T });
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS + 1000));
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
    expect(mockHalo.at(-1)!.dimmed).toBe(true);
    expect(halo().flow).toBe(true);
  });

  test('dims after 10 s without a touch; a tap undims', async () => {
    await renderHud();
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS - 1));
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    await act(() => jest.advanceTimersByTime(1));
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
    // The speed stays (faintly) under the scrim.
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('34');

    await fireEvent(screen.getByTestId('hud-screen'), 'touchStart');
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    // The tap re-arms the timer.
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS - 1));
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    await act(() => jest.advanceTimersByTime(1));
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
  });

  test('never dims while an alert glow is showing', async () => {
    const h = await renderHud();
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS - 500));
    await h.update({ lastAlert: { type: 'hard_corner', tier: 'minor', at: T + 9000 } });
    await act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    await act(() => jest.advanceTimersByTime(500));
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
  });
});

test('while moving, End, the navigation button, "Not driving?" and the weather ✕ are the only controls on the screen, the same as stopped', async () => {
  const fog = { kind: 'dense_fog', gustMph: null, visibilityM: 150 } as const;
  const h = await renderHud({ speedMph: 45 });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav']);
  await h.update({ weatherAlert: fog });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav', 'hud-weather-close']);
  await h.update({ speedMph: 0 });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav', 'hud-weather-close']);
  // while it is offered, "Not driving?" too
  await h.update({ speedMph: 45, notDrivingAvailable: true });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav', 'hud-not-driving', 'hud-weather-close']);
});

describe('the navigation button (design §7.4, §8)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the RN module the default port uses, after the mocks
  const { Linking } = require('react-native') as typeof import('react-native');
  beforeEach(() => {
    jest.spyOn(Linking, 'canOpenURL').mockImplementation(async (url: string) => url === 'waze://' || url === 'maps://');
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  test('it shows while moving, with "Navigate" and no highlight when no app is saved', async () => {
    await renderHud({ speedMph: 25 });
    expect(screen.getByTestId('hud-nav')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Choose a navigation app' })).toBeOnTheScreen();
    expect(screen.getByText('Navigate')).toBeOnTheScreen();
    expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
  });

  test("under a sky the list wears the app's own sheet colours, as in Settings", async () => {
    const mood: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'clear', intensity: 'moderate' } };
    mockLive = live({ rowSpeedMph: 25 });
    setShown({ speedMph: 25, speedAccelMph: 0, speedAt: Date.now() });
    await render(
      <ThemeProvider mood={mood}>
        <HudScreen />
      </ThemeProvider>
    );
    await act(async () => {});
    await fireEvent.press(screen.getByTestId('hud-nav'));
    await act(async () => {});
    const c = skyBundle(mood).colors;
    expect(screen.getByTestId('hud-nav-panel')).toHaveStyle({ backgroundColor: c.surface, borderColor: c.border });
    expect(screen.getByText('Select default navigation app')).toHaveStyle({ color: c.text });
  });

  test('the first tap opens the list of installed apps over the HUD; End still ends the drive with it open', async () => {
    await renderHud({ speedMph: 8 });
    await fireEvent.press(screen.getByTestId('hud-nav'));
    await act(async () => {});
    expect(screen.getByTestId('nav-picker')).toBeOnTheScreen();
    expect(screen.getByText('Select default navigation app')).toBeOnTheScreen();
    expect(screen.getByText('Your drive keeps recording while you navigate.')).toBeOnTheScreen();
    expect(screen.getByTestId('nav-picker-row-apple_maps')).toBeOnTheScreen();
    expect(screen.getByTestId('nav-picker-row-waze')).toBeOnTheScreen();
    // the screen does not dim under the list
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS + 1000));
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await swipeEnd(end);
    await act(async () => {});
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test('with a saved app the highlight shows for the first 30 s of the drive on the row clock, and never once the drive is saving', async () => {
    mockNavApp = 'waze';
    mockLastRowTs = T + 29_000;
    const h = await renderHud();
    expect(screen.getByText('Waze')).toBeOnTheScreen();
    expect(screen.getByTestId('hud-nav-highlight')).toBeOnTheScreen();
    mockLastRowTs = T + 30_000;
    await h.update({});
    expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
    mockLastRowTs = T + 5_000;
    await h.update({ status: 'finalizing' });
    expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
  });

  test('with a saved app, a long press at 25 mph reopens the list with it marked; choosing another saves it and opens it', async () => {
    mockNavApp = 'waze';
    await renderHud({ speedMph: 25 });
    const button = screen.getByRole('button', { name: 'Open Waze' });
    expect(button).toHaveProp('accessibilityHint', 'Touch and hold to change the navigation app.');
    await fireEvent(button, 'longPress');
    await act(async () => {});
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(screen.getByText('Select default navigation app')).toBeOnTheScreen();
    expect(screen.getByTestId('nav-picker-row-waze')).toHaveProp('accessibilityState', { selected: true });
    expect(screen.getByTestId('nav-picker-row-apple_maps')).toHaveProp('accessibilityState', { selected: false });
    await fireEvent.press(screen.getByTestId('nav-picker-row-apple_maps'));
    await act(async () => {});
    expect(Linking.openURL).toHaveBeenCalledWith('maps://');
    expect(screen.queryByTestId('nav-picker')).toBeNull();
    expect(mockDb.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT'), ['navigation.app', JSON.stringify('apple_maps')]);
    expect(screen.getByRole('button', { name: 'Open Apple Maps' })).toBeOnTheScreen();
  });

  test('the screen reader action "Change navigation app" does the same; a tap still opens the saved app', async () => {
    mockNavApp = 'waze';
    await renderHud({ speedMph: 25 });
    const button = screen.getByRole('button', { name: 'Open Waze' });
    expect(button).toHaveProp('accessibilityActions', [{ name: 'change', label: 'Change navigation app' }]);
    await fireEvent(button, 'accessibilityAction', { nativeEvent: { actionName: 'change' } });
    await act(async () => {});
    expect(screen.getByTestId('nav-picker')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('nav-picker-close'));
    await fireEvent.press(screen.getByRole('button', { name: 'Open Waze' }));
    await act(async () => {});
    expect(Linking.openURL).toHaveBeenCalledWith('waze://');
    expect(screen.queryByTestId('nav-picker')).toBeNull();
  });

  test('no saved app: a long press opens the list too (no "change" action); choosing saves it, and the next tap opens it directly', async () => {
    await renderHud({ speedMph: 25 });
    const button = screen.getByRole('button', { name: 'Choose a navigation app' });
    expect(button.props.accessibilityActions).toBeUndefined();
    await fireEvent(button, 'longPress');
    await act(async () => {});
    expect(screen.getByText('Select default navigation app')).toBeOnTheScreen();
    expect(screen.getByTestId('nav-picker-row-waze')).toHaveProp('accessibilityState', { selected: false });
    expect(Linking.openURL).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('nav-picker-row-waze'));
    await act(async () => {});
    expect(Linking.openURL).toHaveBeenCalledWith('waze://');
    expect(mockDb.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT'), ['navigation.app', JSON.stringify('waze')]);
    expect(screen.queryByTestId('nav-picker')).toBeNull();
    mockNavApp = 'waze';
    await fireEvent.press(screen.getByRole('button', { name: 'Open Waze' }));
    await act(async () => {});
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('nav-picker')).toBeNull();
  });

  test('disabled while the drive is saving', async () => {
    await renderHud({ status: 'finalizing' });
    expect(screen.getByTestId('hud-nav').props.accessibilityState).toMatchObject({ disabled: true });
  });

  describe('greyed out at speed', () => {
    const nav = () => screen.getByTestId('hud-nav');
    const locked = () => nav().props.accessibilityState?.disabled === true;

    test('at 35 mph it greys out and takes no tap, saying when it comes back; it stays so down to 30 and is back under 30', async () => {
      const h = await renderHud({ speedMph: 34.9 });
      expect(locked()).toBe(false);
      await h.update({ speedMph: 35 });
      expect(locked()).toBe(true);
      expect(nav()).toHaveProp('accessibilityHint', 'Available below 30 mph.');
      // visibly grey: weaker, on a face that is no longer the paper
      expect(StyleSheet.flatten(nav().props.style)).toMatchObject({ opacity: 0.55 });
      await fireEvent.press(nav());
      await act(async () => {});
      expect(screen.queryByTestId('nav-picker')).toBeNull();
      for (const mph of [33, 31, 30]) {
        await h.update({ speedMph: mph });
        expect(locked()).toBe(true);
        // the hint names where it comes back, so it stays true between 30 and 35
        expect(nav()).toHaveProp('accessibilityHint', 'Available below 30 mph.');
      }
      await h.update({ speedMph: 29.9 });
      expect(locked()).toBe(false);
      expect(nav().props.accessibilityHint).toBeUndefined();
      await fireEvent.press(nav());
      await act(async () => {});
      expect(screen.getByTestId('nav-picker')).toBeOnTheScreen();
    });

    test('an unknown speed holds it as it was, locked or not', async () => {
      const h = await renderHud({ speedMph: 50 });
      expect(locked()).toBe(true);
      await h.update({ speedMph: null });
      expect(locked()).toBe(true);
      await h.update({ speedMph: 20 });
      expect(locked()).toBe(false);
      await h.update({ speedMph: null });
      expect(locked()).toBe(false);
    });

    test('kilometres: the hint in km/h', async () => {
      mockUnits = 'km';
      await renderHud({ speedMph: 60 });
      expect(nav()).toHaveProp('accessibilityHint', 'Available below 48 km/h.');
    });

    test('the open list closes as it locks, and a long press or the screen reader action does nothing while locked', async () => {
      mockNavApp = 'waze';
      const h = await renderHud({ speedMph: 25 });
      await fireEvent(screen.getByRole('button', { name: 'Open Waze' }), 'longPress');
      await act(async () => {});
      expect(screen.getByTestId('nav-picker')).toBeOnTheScreen();
      await h.update({ speedMph: 40 });
      await act(async () => {});
      expect(screen.queryByTestId('nav-picker')).toBeNull();
      const button = screen.getByRole('button', { name: 'Open Waze' });
      expect(button.props.accessibilityActions).toBeUndefined();
      await fireEvent(button, 'longPress');
      await fireEvent(button, 'accessibilityAction', { nativeEvent: { actionName: 'change' } });
      await act(async () => {});
      expect(screen.queryByTestId('nav-picker')).toBeNull();
      expect(Linking.openURL).not.toHaveBeenCalled();
    });

    test('the warm-up highlight hides while it is greyed out', async () => {
      mockNavApp = 'waze';
      mockLastRowTs = T + 5_000;
      const h = await renderHud({ speedMph: 25 });
      expect(screen.getByTestId('hud-nav-highlight')).toBeOnTheScreen();
      await h.update({ speedMph: 45 });
      expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
      await h.update({ speedMph: 20 });
      expect(screen.getByTestId('hud-nav-highlight')).toBeOnTheScreen();
    });
  });
});

describe('DashPal (plan §7.10)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the registry, after the mocks
  const { setActiveDashcam } = require('@/dashcam/registry') as typeof import('@/dashcam/registry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const { createFakeDashcamRuntime, PAIRED } = require('@/dashcam/__fixtures__/fakeRuntime') as typeof import('@/dashcam/__fixtures__/fakeRuntime');

  afterEach(async () => {
    await act(async () => setActiveDashcam(null));
  });

  const visual = (o: { tier: number; sound: number; level?: number; id?: number }) => ({
    key: `${o.id ?? 1}:${o.level ?? 0}`,
    alertId: o.id ?? 1,
    sound: o.sound,
    tier: o.tier,
    level: o.level ?? 0,
    onPhone: true,
    resend: false,
    at: Date.now(),
  });
  const held = (sound: number, tier: number, level = 0) => ({ sound, tier, level, since: Date.now() });

  test('no chip without a paired DashPal; a static chip whose dot follows the link when paired', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    await renderHud();
    expect(screen.queryByTestId('hud-dashpal-chip')).toBeNull();
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    await act(async () => setActiveDashcam(rt));
    expect(screen.getByTestId('hud-dashpal-chip')).toBeTruthy();
    expect(screen.getByTestId('hud-dashpal-dot-ok')).toBeTruthy();
    await act(async () => rt.set({ link: { lifecycle: 'connecting' } }));
    expect(screen.getByTestId('hud-dashpal-dot-warn')).toBeTruthy();
    // Not yet linked is a quiet grey dot, never the minor tier's yellow.
    expect(screen.getByTestId('hud-dashpal-dot-warn', HIDDEN)).toHaveStyle({ backgroundColor: p.inkMuted });
    await act(async () => rt.set({ link: { lifecycle: 'needs_repair' } }));
    expect(screen.getByTestId('hud-dashpal-dot-bad')).toBeTruthy();
  });

  test('a compact window with "Not driving?" offered: the DashPal banner yields to the link; the halo still bursts', async () => {
    compactWindow();
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    await renderHud({ rowTs: T, notDrivingAvailable: true });
    await act(async () => rt.set({ link: { visual: visual({ tier: 3, sound: 3 }), held: held(3, 3) } }));
    expect(screen.queryByTestId('hud-dashpal-alert')).toBeNull();
    expect(within(screen.getByTestId('hud-line')).getByTestId('hud-not-driving')).toBeTruthy();
    expect(halo()).toMatchObject({ mode: 'burst', burst: { key: 'dashpal:1:0' } });
    // gone before the window hook is given back (the afterEach re-renders with the dashcam cleared)
    await screen.unmount();
    jest.restoreAllMocks();
  });

  test('a DashPal alert: its banner for 1.5 s per start or level change, over the event chip; the chip steps aside; a critical bursts red', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    const h = await renderHud({ rowTs: T, speedMph: 41 });
    expect(screen.getByTestId('hud-dashpal-chip')).toBeTruthy();
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'moderate', at: T + 1000 } });
    expect(screen.queryByTestId('hud-dashpal-chip')).toBeNull(); // the event banner takes the band
    await act(async () => rt.set({ link: { visual: visual({ tier: 3, sound: 3 }), held: held(3, 3) } }));
    expect(screen.getByTestId('hud-dashpal-alert')).toHaveTextContent(/Wake up/);
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: { key: 'dashpal:1:0', pulses: 3 } });
    await act(() => jest.advanceTimersByTime(1500));
    expect(screen.queryByTestId('hud-dashpal-alert')).toBeNull();
    expect(screen.getByTestId('hud-dashpal-chip')).toBeTruthy();
    // the critical still held: distraction at 0.80 and more
    expect(halo().mode).toBe('distraction');
    expect(halo().severity).toBeGreaterThanOrEqual(0.8);
  });

  test('a held glance warning ramps from 0.50 to 0.80 over 10 s; a level change flashes and bursts red', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    const h = await renderHud({ rowTs: T });
    await act(async () => rt.set({ link: { held: held(1, 2) } }));
    expect(halo()).toMatchObject({ mode: 'distraction', severity: 0.5 });
    await act(() => jest.advanceTimersByTime(10_000));
    await h.update({ rowTs: T + 10_000 });
    expect(halo().severity).toBeCloseTo(0.8, 6);
    await act(async () => rt.set({ link: { visual: visual({ tier: 2, sound: 1, level: 1 }) } }));
    expect(screen.getByTestId('hud-dashpal-alert')).toHaveTextContent(/Eyes on the road/);
    expect(halo().burst).toMatchObject({ severity: 1, pulses: 3 });
    expect(halo().colorSeverity).toBe(1);
  });

  test('the no-face alert (sound 6): "Driver not visible" banner, a burst, then a pulsing halo that reddens the longer it lasts', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    const h = await renderHud({ rowTs: T });
    await act(async () => rt.set({ link: { visual: visual({ tier: 2, sound: 6 }), held: held(6, 2) } }));
    expect(screen.getByTestId('hud-dashpal-alert')).toHaveTextContent(/Driver not visible/);
    expect(screen.getByTestId('hud-dashpal-alert').props.accessibilityLabel).toBe('DashPal: Driver not visible');
    expect(halo()).toMatchObject({ mode: 'burst', severity: 0.5, colorSeverity: 1, burst: { severity: 1, pulses: 3 } });
    await act(() => jest.advanceTimersByTime(10_000));
    await h.update({ rowTs: T + 10_000 });
    expect(halo()).toMatchObject({ mode: 'distraction', burst: null });
    expect(halo().severity).toBeCloseTo(0.8, 6);
    expect(halo().pulsePeriodMs).toBeGreaterThan(0);
  });

  test('an advisory (a phone-in-hand chime): red three times too', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    await renderHud({ rowTs: T });
    await act(async () => rt.set({ link: { visual: visual({ tier: 1, sound: 4 }) } }));
    expect(halo().burst).toMatchObject({ severity: 1, pulses: 3 });
  });

  test('a reconnect re-send shows its banner but never bursts; a visual 5 s old at mount shows nothing', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    await renderHud({ rowTs: T });
    await act(async () => rt.set({ link: { visual: { ...visual({ tier: 3, sound: 3 }), resend: true } } }));
    expect(screen.getByTestId('hud-dashpal-alert')).toBeTruthy();
    expect(halo().burst).toBeNull();
    await act(async () => setActiveDashcam(null));

    const old = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected', visual: { ...visual({ tier: 3, sound: 3, id: 9 }), at: Date.now() - 5000 } } });
    await act(async () => setActiveDashcam(old));
    mockHalo.length = 0;
    await renderHud({ rowTs: T });
    expect(screen.queryByTestId('hud-dashpal-alert')).toBeNull();
    expect(mockHalo.every((x) => x.visual.burst === null)).toBe(true);
  });

  test('never dims while a DashPal alert shows', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    await renderHud();
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS - 500));
    await act(async () => rt.set({ link: { visual: visual({ tier: 2, sound: 2 }) } }));
    await act(() => jest.advanceTimersByTime(1000));
    expect(screen.queryByTestId('hud-dim')).toBeNull();
  });
});

describe('layout, accessibility and Reduce Motion', () => {
  test('the speed is reachable for screen readers on the full screen', async () => {
    await renderHud({ speedMph: 34 });
    expect(screen.getByLabelText(/Speed 34 miles per hour/)).toBeTruthy();
  });

  test('miles: the SPEED LIMIT sign; kilometres: the round sign', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-limit-words')).toHaveTextContent('SPEEDLIMIT');
    mockUnits = 'km';
    await renderHud();
    expect(screen.queryByTestId('hud-limit-words')).toBeNull();
    expect(screen.getByTestId('hud-limit')).toHaveStyle({ borderColor: p.signRing });
  });

  test('the top row holds the sign and the navigation button; End is at the bottom', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-limit')).toBeTruthy();
    expect(screen.getByTestId('hud-end')).toBeTruthy();
    expect(screen.getByTestId('hud-nav')).toBeTruthy();
  });

  test('Reduce Motion: no pulse, no flow, colours unchanged, a burst as colour only', async () => {
    mockStill = true;
    const h = await renderHud({ rowTs: T, speedMph: 52, speedingRatio: 52 / 35, speedingOver: true });
    expect(halo()).toMatchObject({ mode: 'speeding', pulsePeriodMs: 0, flow: false });
    expect(halo().colorSeverity).toBeCloseTo((52 / 35 - 1) / 0.7, 9);
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: null });
    expect(screen.queryByTestId('hud-halo-flow', HIDDEN)).toBeNull();
  });

  test('not recording (saving): calm whatever the signals', async () => {
    await renderHud({ status: 'finalizing', rowTs: T, speedMph: 90, speedingRatio: 2, speedingOver: true, lastShake: { key: 'k', tier: 'severe', at: T } });
    expect(halo().mode).toBe('calm');
  });
});

/** A compact window (short and wide): no ring, the band between the sign and the navigation button. */
function compactWindow(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
  const dims = require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
  jest.spyOn(dims, 'default').mockReturnValue({ width: 400, height: 300, scale: 2, fontScale: 1 });
}

describe('End locks at speed (modes plan §3.6)', () => {
  const end = () => screen.getByTestId('hud-end');
  const locked = () => end().props.accessibilityState?.disabled === true;

  test('at 20 mph it greys out with a lock and takes no swipe, saying when it comes back; it stays so down to 10 and is back under 10', async () => {
    const h = await renderHud({ speedMph: 19.9 });
    expect(locked()).toBe(false);
    expect(end()).toHaveProp('accessibilityHint', hudCopy.endHint);
    await h.update({ speedMph: 20 });
    expect(locked()).toBe(true);
    expect(end()).toHaveProp('accessibilityHint', 'Available below 10 mph.');
    expect(end()).toHaveStyle({ opacity: 0.5 });
    expect(screen.queryByTestId('hud-end-chevron', HIDDEN)).toBeNull();
    // the label stays; nothing ends
    expect(within(end()).getByText(hudCopy.end)).toBeTruthy();
    await swipeEnd(end());
    expect(mockEnd).not.toHaveBeenCalled();
    for (const mph of [19, 14, 10]) {
      await h.update({ speedMph: mph });
      expect(locked()).toBe(true);
    }
    await h.update({ speedMph: 9.9 });
    expect(locked()).toBe(false);
    expect(screen.getByTestId('hud-end-chevron', HIDDEN)).toBeTruthy();
    await swipeEnd(end());
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test('an unknown speed holds it as it was; kilometres say km/h', async () => {
    mockUnits = 'km';
    const h = await renderHud({ speedMph: 50 });
    expect(locked()).toBe(true);
    expect(end()).toHaveProp('accessibilityHint', 'Available below 16 km/h.');
    await h.update({ speedMph: null });
    expect(locked()).toBe(true);
    await h.update({ speedMph: 5 });
    await h.update({ speedMph: null });
    expect(locked()).toBe(false);
  });
});

describe('"Not driving?" (modes plan §3.6)', () => {
  const link = () => screen.getByTestId('hud-not-driving');

  test('while it is offered, at any speed: a small underlined link in its row above End, labelled for screen readers', async () => {
    await renderHud({ speedMph: 60, notDrivingAvailable: true });
    expect(link()).toHaveProp('accessibilityLabel', 'Not driving? Stop this drive');
    expect(link()).toHaveProp('accessibilityHint', "Stops recording. This trip won't count.");
    expect(within(link()).getByText('Not driving?')).toHaveStyle({ textDecorationLine: 'underline', color: p.inkMuted, fontSize: 18 });
    // its touch box reaches 64 pt through the slop
    expect(link().props.hitSlop).toEqual({ top: 10, bottom: 10 });
    // in its own row, not the band's line
    expect(within(screen.getByTestId('hud-line')).queryByTestId('hud-not-driving')).toBeNull();
  });

  test('gone once its budget is spent, and never while saving', async () => {
    const h = await renderHud({ notDrivingAvailable: true });
    expect(link()).toBeOnTheScreen();
    await h.update({ notDrivingAvailable: false });
    expect(screen.queryByTestId('hud-not-driving')).toBeNull();
    await h.update({ notDrivingAvailable: true, status: 'finalizing' });
    expect(screen.queryByTestId('hud-not-driving')).toBeNull();
  });

  test('a tap discards the drive and goes Home, where the notice says it won’t count', async () => {
    await renderHud({ speedMph: 40, notDrivingAvailable: true });
    await act(async () => {
      fireEvent.press(link());
    });
    expect(mockControls.cancelDrive).toHaveBeenCalledTimes(1);
    expect(readHomeNotice()).toBe('notDriving');
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('refused (the budget ran out between the render and the tap): the notice is taken back and the drive goes on', async () => {
    mockControls.cancelDrive.mockResolvedValueOnce(false);
    await renderHud({ notDrivingAvailable: true });
    await act(async () => {
      fireEvent.press(link());
    });
    expect(mockControls.cancelDrive).toHaveBeenCalledTimes(1);
    expect(readHomeNotice()).toBeNull();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('a touch that starts while the screen is dimmed only wakes it', async () => {
    await renderHud({ notDrivingAvailable: true });
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS));
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
    await fireEvent(link(), 'pressIn');
    await fireEvent(screen.getByTestId('hud-screen'), 'touchStart');
    await act(async () => {
      fireEvent.press(link());
    });
    expect(mockControls.cancelDrive).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    // awake, the next touch counts
    await fireEvent(link(), 'pressIn');
    await act(async () => {
      fireEvent.press(link());
    });
    expect(mockControls.cancelDrive).toHaveBeenCalledTimes(1);
  });

  test('a compact window puts it in the band line, under a failed end and over a spot nudge and the weather', async () => {
    compactWindow();
    const fog = { kind: 'dense_fog', gustMph: null, visibilityM: 150 } as const;
    const h = await renderHud({ rowTs: T, notDrivingAvailable: true, weatherAlert: fog });
    const line = () => screen.getByTestId('hud-line');
    expect(within(line()).getByTestId('hud-not-driving')).toBeTruthy();
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    await h.update({ rowTs: T + 1000, spotNudge: { key: `s1@${T + 1000}`, spotId: 's1', kind: 'speeding', at: T + 1000 } });
    expect(within(line()).getByTestId('hud-not-driving')).toBeTruthy();
    expect(screen.queryByTestId('hud-spot')).toBeNull();
    // spent: the weather comes back
    await h.update({ notDrivingAvailable: false });
    expect(screen.queryByTestId('hud-not-driving')).toBeNull();
    jest.restoreAllMocks();
  });

  test('a compact window: an event banner yields to the link while it is offered (a run of alerts can never hide it); a tap still discards', async () => {
    compactWindow();
    const h = await renderHud({ rowTs: T, notDrivingAvailable: true });
    const line = () => screen.getByTestId('hud-line');
    // alert after alert, each before the last one's 1.5 s is out: the link stays, the halo still bursts
    for (let i = 1; i <= 5; i += 1) {
      await h.update({ rowTs: T + i * 1000, lastAlert: { type: i % 2 === 0 ? 'hard_brake' : 'hard_accel', tier: 'severe', at: T + i * 1000 } });
      expect(within(line()).getByTestId('hud-not-driving')).toBeTruthy();
      expect(screen.queryByTestId('hud-alert')).toBeNull();
      expect(halo().mode).toBe('burst');
      await act(() => jest.advanceTimersByTime(1000));
    }
    // a tap still discards
    await act(async () => {
      fireEvent.press(screen.getByTestId('hud-not-driving'));
    });
    expect(mockControls.cancelDrive).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  test('a compact window: once the link is spent an alert banner takes the band again', async () => {
    compactWindow();
    const h = await renderHud({ rowTs: T, notDrivingAvailable: true });
    await h.update({ notDrivingAvailable: false, rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    expect(screen.queryByTestId('hud-not-driving')).toBeNull();
    jest.restoreAllMocks();
  });

  test('a full-size window: the link keeps its own row while an event banner takes the band', async () => {
    const h = await renderHud({ rowTs: T, notDrivingAvailable: true });
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    expect(screen.getByTestId('hud-not-driving')).toBeTruthy();
    expect(screen.queryByTestId('hud-line')).toBeNull();
  });

  test('a tap whose discard throws: the notice is taken back and the screen stays', async () => {
    mockControls.cancelDrive.mockRejectedValueOnce(new Error('queue'));
    await renderHud({ notDrivingAvailable: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('hud-not-driving'));
    });
    expect(readHomeNotice()).toBeNull();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    // and the link is there for another try
    expect(screen.getByTestId('hud-not-driving')).toBeTruthy();
  });

  test('the diagnostics simulation never tells the host it is the driving screen', async () => {
    mockLive = live({ notDrivingAvailable: true });
    await render(<HudScreen overlay />);
    expect(mockControls.setHudVisible).not.toHaveBeenCalled();
  });

  test('the screen tells the host it is showing (the budget counts), and that it is not once it goes', async () => {
    const r = await render(<HudScreen />);
    expect(mockControls.setHudVisible).toHaveBeenLastCalledWith(true);
    await r.unmount();
    expect(mockControls.setHudVisible).toHaveBeenLastCalledWith(false);
  });
});

describe('presence (hudPresence: the recap notifier and the lockout read it)', () => {
  test('focused with RoadWise in front: the driving screen is focused, and entered for this drive', async () => {
    expect(isDriveScreenFocused()).toBe(false);
    await renderHud({ clientTripId: 't1' });
    expect(isDriveScreenFocused()).toBe(true);
    expect(driveScreenEnteredFor('t1')).toBe(true);
    expect(driveScreenEnteredFor('t2')).toBe(false);
  });

  test('the background and back, a blur and back, then unmount', async () => {
    const app = appStateListeners();
    try {
      const h = await renderHud({ clientTripId: 't1' });
      expect(isDriveScreenFocused()).toBe(true);
      await app.set('background');
      expect(isDriveScreenFocused()).toBe(false);
      await app.set('inactive');
      expect(isDriveScreenFocused()).toBe(false);
      await app.set('active');
      expect(isDriveScreenFocused()).toBe(true);
      mockFocused = false;
      await h.update({ rowTs: T + 1000 });
      expect(isDriveScreenFocused()).toBe(false);
      mockFocused = true;
      await h.update({ rowTs: T + 2000 });
      expect(isDriveScreenFocused()).toBe(true);
      await screen.unmount();
      expect(isDriveScreenFocused()).toBe(false);
      // it was entered during this drive all the same
      expect(driveScreenEnteredFor('t1')).toBe(true);
    } finally {
      app.restore();
    }
  });

  test('opened in the background (never in front): not focused, not entered', async () => {
    const app = appStateListeners();
    const was = AppState.currentState;
    const target = AppState as unknown as { currentState: unknown };
    target.currentState = 'background';
    try {
      await renderHud({ clientTripId: 't1' });
      expect(isDriveScreenFocused()).toBe(false);
      expect(driveScreenEnteredFor('t1')).toBe(false);
      await app.set('active');
      expect(isDriveScreenFocused()).toBe(true);
      expect(driveScreenEnteredFor('t1')).toBe(true);
    } finally {
      target.currentState = was;
      app.restore();
    }
  });

  test("a drive id that arrives after the screen opened is entered; the drive's end (its id cleared) keeps the screen focused until it goes", async () => {
    const h = await renderHud({ clientTripId: null });
    expect(isDriveScreenFocused()).toBe(true);
    await h.update({ clientTripId: 't7' });
    expect(driveScreenEnteredFor('t7')).toBe(true);
    await h.update({ status: 'finalizing', clientTripId: null });
    expect(isDriveScreenFocused()).toBe(true);
  });

  test('a focus listener hears each change once (no flapping on a re-render or a new row)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the module the screen writes
    const { subscribeDriveScreen } = require('../hudPresence') as typeof import('../hudPresence');
    const heard: boolean[] = [];
    const off = subscribeDriveScreen((f) => heard.push(f));
    const h = await renderHud({ clientTripId: 't1' });
    for (let i = 1; i <= 3; i += 1) await h.update({ rowTs: T + i * 1000, speedMph: 30 + i });
    await screen.unmount();
    off();
    expect(heard).toEqual([true, false]);
  });

  test('two driving screens overlapping for a moment (one opening as the other goes): the one that goes never clears the other', async () => {
    mockLive = live({ clientTripId: 't1' });
    const heard: boolean[] = [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the module the screen writes
    const off = (require('../hudPresence') as typeof import('../hudPresence')).subscribeDriveScreen((f) => heard.push(f));
    const r = await render(
      <View>
        <HudScreen key="a" />
        <HudScreen key="b" />
      </View>
    );
    await act(async () => {});
    expect(isDriveScreenFocused()).toBe(true);
    await r.rerender(
      <View>
        <HudScreen key="b" />
      </View>
    );
    expect(heard).toEqual([true]);
    expect(isDriveScreenFocused()).toBe(true);
    await r.unmount();
    expect(isDriveScreenFocused()).toBe(false);
    off();
  });

  test('the diagnostics simulation is never the driving screen', async () => {
    mockLive = live({ clientTripId: 't1' });
    const r = await render(<HudScreen overlay />);
    await act(async () => {});
    expect(isDriveScreenFocused()).toBe(false);
    expect(driveScreenEnteredFor('t1')).toBe(false);
    await r.unmount();
    expect(isDriveScreenFocused()).toBe(false);
  });
});

describe('the band: a spot nudge, the weather, a failed end', () => {
  const ICE = { kind: 'freezing_rain', gustMph: null, visibilityM: null } as const;
  const spot = (at: number, kind: 'speeding' | 'hard_brake' = 'speeding') => ({ key: `s1@${at}`, spotId: 's1', kind, at });

  test('a nudge covers the weather banner for its 4 s, then the banner is back', async () => {
    const h = await renderHud({ rowTs: T, weatherAlert: ICE });
    expect(screen.getByTestId('hud-weather')).toBeTruthy();
    await h.update({ rowTs: T + 1000, spotNudge: spot(T + 1000) });
    expect(screen.getByTestId('hud-spot')).toHaveProp('accessibilityLabel', 'Watch your speed here');
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    await act(() => jest.advanceTimersByTime(3999));
    expect(screen.getByTestId('hud-spot')).toBeTruthy();
    await act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByTestId('hud-spot')).toBeNull();
    expect(screen.getByTestId('hud-weather')).toBeTruthy();
  });

  test('an event chip hides it; a failed end wins over it', async () => {
    mockDefaultMph = 8;
    mockEnd.mockRejectedValueOnce(new Error('busy'));
    const h = await renderHud({ rowTs: T });
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 }, spotNudge: spot(T + 1000, 'hard_brake') });
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    expect(screen.queryByTestId('hud-spot')).toBeNull();
    await swipeEnd();
    await act(() => jest.advanceTimersByTime(1500));
    await h.update({ rowTs: T + 3000, spotNudge: spot(T + 3000) });
    expect(screen.getByTestId('hud-end-failed')).toBeTruthy();
    expect(screen.queryByTestId('hud-spot')).toBeNull();
  });

  test('the screen does not dim while a nudge shows', async () => {
    const h = await renderHud({ rowTs: T });
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS - 500));
    await h.update({ rowTs: T + 1000, spotNudge: spot(T + 1000) });
    await act(() => jest.advanceTimersByTime(1000));
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    await act(() => jest.advanceTimersByTime(3000));
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
  });

  test('a moving line is three words at most, a nudge four', () => {
    for (const words of [...Object.values(hudCopy.alert), hudCopy.endFailed, hudCopy.notDriving]) expect(words.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    for (const words of Object.values(hudCopy.spot)) expect(words.trim().split(/\s+/).length).toBeLessThanOrEqual(4);
  });
});

describe('a Start-card drive waiting for driving speed (drive-fixes brief)', () => {
  const W = (o: Partial<NonNullable<DriveLive['waiting']>> = {}): NonNullable<DriveLive['waiting']> => ({
    since: T,
    phase: 'waiting',
    deadlineAt: T + 120_000,
    ...o,
  });
  /** The host's state while it waits: the drive records from the tap (its own speed and limit). */
  const waitDrive = (o: Partial<NonNullable<DriveLive['waiting']>> = {}, over: LiveOver = {}): LiveOver => ({
    status: 'recording',
    clientTripId: 't1',
    speedMph: null,
    limitMph: null,
    notDrivingAvailable: false,
    waiting: W(o),
    ...over,
  });

  test('the band says "Ready to roll" · "Saved once you drive"; End is Cancel, never locked; the halo and the sign are the drive’s own', async () => {
    const h = await renderHud(waitDrive());
    expect(screen.getByTestId('hud-waiting')).toHaveTextContent(/Ready to roll/);
    expect(screen.getByTestId('hud-waiting-line')).toHaveTextContent('Saved once you drive');
    expect(screen.getByTestId('hud-waiting')).toHaveProp('accessibilityLabel', "Ready to roll. Recording now; the drive is saved once you're driving.");
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveProp('accessibilityHint', 'Swipe right to stop waiting. Nothing is saved.');
    expect(cancel).not.toBeDisabled();
    // the limit unknown before the drive's first fix
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('-');
    await h.update({ speedMph: 12, limitMph: 25 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('12');
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('25');
    // at 12 mph End stays a Cancel that takes a swipe
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    // the navigation button works
    expect(screen.getByTestId('hud-nav').props.accessibilityState).toMatchObject({ disabled: false });
  });

  test('the sign shows the drive’s own limit while a Start-card drive waits, as the lock screen does (user report: the sign stayed "-" on the driving screen while the widget showed 35)', async () => {
    // The host's state on an iPhone: the engine holds the limit (the Live Activity shows it).
    await renderHud(waitDrive({}, { limitMph: 35, speedMph: 12 }));
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    expect(screen.getByLabelText('Speed limit 35')).toBeTruthy();
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('12');
  });

  test('"Not driving?" never shows while the drive waits (Cancel is the one discard then); once at driving speed it follows the drive’s budget', async () => {
    const h = await renderHud(waitDrive({}, { notDrivingAvailable: true }));
    expect(screen.queryByTestId('hud-not-driving')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await h.update({ waiting: null, speedMph: 12, notDrivingAvailable: true });
    expect(screen.getByTestId('hud-not-driving')).toBeTruthy();
    await h.update({ notDrivingAvailable: false });
    expect(screen.queryByTestId('hud-not-driving')).toBeNull();
  });

  test('any touch on the screen waits a fresh 5 minutes; with no wait, a touch only undims', async () => {
    const h = await renderHud(waitDrive());
    await fireEvent(screen.getByTestId('hud-screen'), 'touchStart');
    expect(mockControls.touchWaiting).toHaveBeenCalledTimes(1);
    await h.update({ waiting: null, speedMph: 12 });
    await fireEvent(screen.getByTestId('hud-screen'), 'touchStart');
    expect(mockControls.touchWaiting).toHaveBeenCalledTimes(1);
  });

  test('at 2:00 the panel asks "Still planning to drive?" with one light haptic; Keep waiting is a touch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module
    const Haptics = require('expo-haptics') as { impactAsync: jest.Mock };
    jest.setSystemTime(T + 120_000);
    const h = await renderHud(waitDrive());
    expect(screen.queryByTestId('hud-wait')).toBeNull();
    await h.update({ waiting: W({ phase: 'popup', deadlineAt: T + 270_000 }) });
    expect(screen.getByTestId('hud-wait')).toBeTruthy();
    expect(screen.getByText('Still planning to drive?')).toBeTruthy();
    expect(screen.getByTestId('hud-wait-body')).toHaveTextContent("We'll stop waiting in 3 min.");
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(mockControls.touchWaiting).toHaveBeenCalled();
    // the host restarts the wait: the panel closes
    await h.update({ waiting: W({ since: T + 121_000, deadlineAt: T + 241_000 }) });
    expect(screen.queryByTestId('hud-wait')).toBeNull();
  });

  test('from 4:30 it counts down, a second at a time, with one more light haptic', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module
    const Haptics = require('expo-haptics') as { impactAsync: jest.Mock };
    jest.setSystemTime(T + 273_000);
    await renderHud(waitDrive({ phase: 'countdown', deadlineAt: T + 300_000 }));
    expect(screen.getByText('Stopping in')).toBeTruthy();
    expect(screen.getByTestId('hud-wait-countdown')).toHaveTextContent('0:27');
    expect(screen.getByLabelText('Stopping in 27 seconds. Touch the screen to keep waiting.')).toBeTruthy();
    expect(screen.getByText('Touch the screen to keep waiting.')).toBeTruthy();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    await act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByTestId('hud-wait-countdown')).toHaveTextContent('0:26');
  });

  test('Cancel on the panel ends the drive unsaved and goes Home, saying nothing', async () => {
    jest.setSystemTime(T + 130_000);
    await renderHud(waitDrive({ phase: 'popup', deadlineAt: T + 270_000 }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('hud-wait-cancel'));
    });
    expect(mockControls.cancelWaiting).toHaveBeenCalledTimes(1);
    expect(mockControls.touchWaiting).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(readHomeNotice()).toBeNull();
  });

  test('End swiped while waiting is Cancel: the drive ends unsaved and the screen goes Home', async () => {
    await renderHud(waitDrive());
    await act(async () => {
      await swipeEnd(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mockControls.cancelWaiting).toHaveBeenCalledTimes(1);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
  });

  test('a Cancel that lands as the car reaches driving speed (the host no longer waits) stays on the drive: no Home, End is End again', async () => {
    const h = await renderHud(waitDrive({}, { speedMph: 12 }));
    // The row that reached driving speed was taken in before the Cancel ran: nothing was cancelled.
    mockControls.cancelWaiting.mockImplementationOnce(async () => {
      mockLive = { ...mockLive, waiting: null };
    });
    await act(async () => {
      await swipeEnd(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mockControls.cancelWaiting).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await h.update({ waiting: null });
    expect(screen.getByRole('button', { name: hudCopy.endLabel })).not.toBeDisabled();
    expect(screen.getByText(hudCopy.end)).toBeTruthy();
  });

  test('the panel closes the navigation list', async () => {
    jest.setSystemTime(T + 100_000);
    const h = await renderHud(waitDrive());
    await fireEvent.press(screen.getByTestId('hud-nav'));
    await act(async () => {});
    expect(screen.getByTestId('hud-nav-panel')).toBeTruthy();
    jest.setSystemTime(T + 120_000);
    await h.update({ waiting: W({ phase: 'popup', deadlineAt: T + 270_000 }) });
    await act(async () => {});
    expect(screen.queryByTestId('hud-nav-panel')).toBeNull();
    expect(screen.getByTestId('hud-wait')).toBeTruthy();
  });

  test('reaching driving speed closes the panel and the band at once, and the screen stays on the same drive', async () => {
    jest.setSystemTime(T + 280_000);
    const h = await renderHud(waitDrive({ phase: 'countdown', deadlineAt: T + 300_000 }));
    expect(screen.getByTestId('hud-wait')).toBeTruthy();
    await h.update({ waiting: null, speedMph: 12, notDrivingAvailable: true });
    expect(screen.queryByTestId('hud-wait')).toBeNull();
    expect(screen.queryByTestId('hud-waiting')).toBeNull();
    expect(screen.getByRole('button', { name: hudCopy.endLabel })).toBeTruthy();
    expect(screen.getByTestId('hud-not-driving')).toBeTruthy();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a wait that runs out ends the drive unsaved: Home once, no notice', async () => {
    const h = await renderHud(waitDrive());
    mockLastFinalized = { clientTripId: 't1', ok: true, status: null, dropped: 'no_movement', endCause: 'manual', at: T, durationS: null, miles: null };
    await h.update({ waiting: null, status: 'idle', clientTripId: null });
    await h.update({ waiting: null, status: 'idle', clientTripId: null });
    expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(readHomeNotice()).toBeNull();
  });
});

describe('a Start-card drive, as a real host publishes it (review I1)', () => {
  /** Every state an Android host (a dry run: nothing stored) publishes from the tap until the car has reached driving speed. */
  async function hostStates(): Promise<DriveState[]> {
    let clock = DRIVE_T0;
    let ids = 0;
    const source = createFakeDriveSense({ platform: 'android', now: () => clock });
    source.setState({ location: 'whenInUse', motion: 'granted', lockSignal: 'reliable' });
    const appState = {
      currentState: 'active' as string | null,
      addEventListener: () => ({ remove: () => {} }),
    };
    const limit = { limitMps: 35 * MPS_PER_MPH, source: 'posted', matchConfidence: 0.95, parallelRoads: false };
    const host = createDriveHost({
      db: { execute: async () => ({ rows: [], changes: 0 }), transaction: async () => Promise.reject(new Error('dry run')) } as never,
      source,
      limits: { lookup: () => limit, lookupStored: async () => limit, startTrip: () => {}, prefetch: () => {}, resetTrip: () => {} } as never,
      player: { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {} },
      now: () => clock,
      tz: () => DRIVE_TZ,
      newId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
      appVersion: '2.0.0',
      persistence: 'none',
      permissions: async () => ({ location: 'granted' }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
      appState,
      weather: async () => null,
      spots: { readWatchSpots: async () => [] },
    });
    await host.boot();
    const states: DriveState[] = [];
    host.subscribe((st) => states.push(st));
    await host.start();
    const list = [...driveRows(5, { speedMps: 0 }), ...driveRows(5, { t0: DRIVE_T0 + 5000, speedMps: 15 })];
    source.loadTrace(list);
    for (const r of list) {
      clock = r.ts;
      source.step();
      await host.settled();
    }
    await host.stop({ endOpenTrip: false });
    return states;
  }

  const liveOf = (st: DriveState): LiveOver => ({
    status: st.status,
    clientTripId: st.clientTripId,
    limitMph: st.limitMph,
    notDrivingAvailable: st.notDrivingAvailable,
    rowTs: st.lastRowTs,
    speedMph: st.rowSpeedMps === null ? null : Math.round((st.rowSpeedMps / MPS_PER_MPH) * 10) / 10,
    waiting: st.waiting === null ? null : { ...st.waiting, since: T, deadlineAt: T + 120_000 },
  });

  test('every state published from the tap is the drive, waiting with the drive’s own limit, then driving: never Home', async () => {
    jest.useRealTimers();
    const states = await hostStates();
    jest.useFakeTimers();
    jest.setSystemTime(T);
    expect(states.every((st) => st.status === 'recording')).toBe(true);
    const over = states.findIndex((st) => st.waiting === null);
    expect(over).toBeGreaterThan(0);
    const h = await renderHud(liveOf(states[0]!));
    expect(screen.getByTestId('hud-waiting')).toBeTruthy();
    for (const st of states.slice(1, over)) await h.update(liveOf(st));
    // still waiting, the sign the drive's own limit
    expect(screen.getByTestId('hud-waiting')).toBeTruthy();
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    for (const st of states.slice(over)) await h.update(liveOf(st));
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hud-waiting')).toBeNull();
    expect(screen.getByRole('button', { name: hudCopy.endLabel })).toBeTruthy();
  });
});

// Jest compiles this suite to CommonJS, so `__dirname` is real at run time.
declare const __dirname: string;

describe("the driving screen wears the hour's sky, still", () => {
  const STORM_AT_DUSK: SkyMood = { phase: 'dusk', glow: 1, weather: { kind: 'storm', intensity: 'heavy' } };
  const RAIN_BY_DAY: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'rain', intensity: 'heavy' } };

  test.each([
    ['a storm at dusk', STORM_AT_DUSK],
    ['heavy rain by day', RAIN_BY_DAY],
  ])('under %s: its deepened sky as a gradient, no moving weather layer, and the speed in the HUD palette exactly as without a sky', async (_name, mood) => {
    mockLive = live();
    const plain = await render(<HudScreen />);
    await act(async () => {});
    const bare = screen.getAllByTestId('hud-speed-digit', HIDDEN)[0]!.props.style;
    await plain.rerender(
      <ThemeProvider mood={mood}>
        <HudScreen />
      </ThemeProvider>
    );
    await act(async () => {});
    // the gradient holds its colours as processed ARGB numbers; with no cached position the sky's
    // own scheme says day or night (dark at dusk)
    const argb = (hex: string) => 0xff000000 + parseInt(hex.slice(1), 16);
    const bundle = skyBundle(mood);
    expect(screen.getByTestId('hud-sky', HIDDEN).props.colors).toEqual(bundle.sky.hud[bundle.scheme === 'dark' ? 'night' : 'day'].stops.map(argb));
    expect(screen.queryByTestId('sky-backdrop', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('sky-ambient', HIDDEN)).toBeNull();
    // the speed in the HUD palette of that set, as without a sky (the day set: exactly as bare)
    const set = bundle.scheme === 'dark' ? 'night' : 'day';
    expect(JSON.stringify(screen.getAllByTestId('hud-speed-digit', HIDDEN)[0]!.props.style)).toContain(HUD[set].haloInk);
    expect(mockHalo.at(-1)!.palette.haloInk).toBe(HUD[set].haloInk);
    expect(set === 'night' || JSON.stringify(screen.getAllByTestId('hud-speed-digit', HIDDEN)[0]!.props.style) === JSON.stringify(bare)).toBe(true);
    expect(halo().mode).toBe('calm');
  });

  test('a new row under a sky hands the halo the same palette and End the same swipe gesture (nothing under the screen is rebuilt)', async () => {
    const mood: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'clear', intensity: 'moderate' } };
    mockLive = live({ rowTs: T });
    const tree = () => (
      <ThemeProvider mood={mood}>
        <HudScreen />
      </ThemeProvider>
    );
    const r = await render(tree());
    await act(async () => {});
    const palette = mockHalo.at(-1)!.palette;
    const gesture = getByGestureTestId('hud-end-pan');
    mockLive = { ...mockLive, rowTs: T + 1000, rowSpeedMph: 12 };
    await r.rerender(tree());
    expect(mockHalo.at(-1)!.palette).toBe(palette);
    expect(getByGestureTestId('hud-end-pan')).toBe(gesture);
  });

  test('Adaptive: night by the sun at the last known position, over the sky\'s own scheme', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module
    const Location = require('expo-location') as { getLastKnownPositionAsync: jest.Mock };
    // 2026-09-21 14:13 UTC: night in Tokyo (23:13), morning in Los Angeles (07:13)
    const mood: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'clear', intensity: 'moderate' } };
    const argb = (hex: string) => 0xff000000 + parseInt(hex.slice(1), 16);
    Location.getLastKnownPositionAsync.mockResolvedValueOnce({ coords: { latitude: 35.68, longitude: 139.69 } });
    mockLive = live();
    const tokyo = await render(
      <ThemeProvider mood={mood}>
        <HudScreen />
      </ThemeProvider>
    );
    await act(async () => {});
    expect(screen.getByTestId('hud-sky', HIDDEN).props.colors).toEqual(skyBundle(mood).sky.hud.night.stops.map(argb));
    expect(mockHalo.at(-1)!.palette.haloInk).toBe(HUD.night.haloInk);
    await tokyo.unmount();
    Location.getLastKnownPositionAsync.mockResolvedValueOnce({ coords: { latitude: 34.05, longitude: -118.24 } });
    await render(
      <ThemeProvider mood={{ ...mood, phase: 'night' }}>
        <HudScreen />
      </ThemeProvider>
    );
    await act(async () => {});
    expect(screen.getByTestId('hud-sky', HIDDEN).props.colors).toEqual(skyBundle({ ...mood, phase: 'night' }).sky.hud.day.stops.map(argb));
  });

  test.each([
    ['Dark', 'dark', 'night'],
    ['Light', 'light', 'day'],
  ] as const)('a static %s theme decides day or night itself, whatever the sun', async (_name, scheme, set) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module
    const Location = require('expo-location') as { getLastKnownPositionAsync: jest.Mock };
    // the sun would say the opposite (morning in Los Angeles, night in Tokyo), and is never asked
    Location.getLastKnownPositionAsync.mockResolvedValue({ coords: { latitude: scheme === 'dark' ? 34.05 : 35.68, longitude: scheme === 'dark' ? -118.24 : 139.69 } });
    let theme: Theme | null = null;
    const Grab = () => {
      theme = useTheme();
      return null;
    };
    mockLive = live();
    await render(
      <ThemeProvider scheme={scheme}>
        <Grab />
        <HudScreen />
      </ThemeProvider>
    );
    await act(async () => {});
    const argb = (hex: string) => 0xff000000 + parseInt(hex.slice(1), 16);
    expect(theme!.hudNight).toBe(scheme === 'dark');
    expect(screen.getByTestId('hud-sky', HIDDEN).props.colors).toEqual(theme!.sky.hud[set].stops.map(argb));
    expect(mockHalo.at(-1)!.palette.haloInk).toBe(HUD[set].haloInk);
    expect(Location.getLastKnownPositionAsync).not.toHaveBeenCalled();
    Location.getLastKnownPositionAsync.mockImplementation(async () => null);
  });

  test('the night rule: a static theme first, then the sun, then the sky scheme; outside a theme with no position, day', () => {
    expect(hudNightOf(true, false, 'light')).toBe(true);
    expect(hudNightOf(false, true, 'dark')).toBe(false);
    expect(hudNightOf(null, true, 'light')).toBe(true);
    expect(hudNightOf(null, false, 'dark')).toBe(false);
    expect(hudNightOf(null, null, 'dark')).toBe(true);
    expect(hudNightOf(null, null, 'light')).toBe(false);
    expect(hudNightOf(undefined, null, null)).toBe(false);
  });

  test('outside a theme it stays on true black', async () => {
    await renderHud();
    expect(screen.queryByTestId('hud-sky', HIDDEN)).toBeNull();
    expect(screen.getByTestId('hud-screen')).toHaveStyle({ backgroundColor: HUD.day.ground });
  });

  test('no driving-screen source draws the moving sky (its weather layer, the scene) or reads the mood itself', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
    const fs = require('node:fs') as {
      readdirSync(dir: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
      readFileSync(file: string, enc: 'utf8'): string;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
    const path = require('node:path') as { join(...parts: string[]): string };
    const root = path.join(__dirname, '..', '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(full);
        } else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    for (const dir of ['src/features/drive', 'src/ui/drive', 'app/drive']) walk(path.join(root, dir));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect({ file: f, sky: /ui\/sky|SkyBackdrop|SkyScene|useSkyMood|sky-ambient/.test(src) }).toEqual({ file: f, sky: false });
    }
  });
});
