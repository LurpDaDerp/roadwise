import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { LastFinalized } from '@/drive/host';
import type { DriveLive, ShownSpeed } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { DIM_AFTER_MS, END_SWIPE_H_PT, HUD, HUD_MIN_TARGET_PT, type HaloProps, type HaloVisual } from '@/ui/drive';
import { skyBundle, type SkyMood } from '@/ui/sky/palette';
import { ThemeProvider, useTheme, type Theme } from '@/ui/theme';

import { hudCopy } from '../hudCopy';
import { hudLayout } from '../hudLayout';
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
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn(async () => null) }));
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
const mockEnd = jest.fn<Promise<{ clientTripId: string; dropped: 'no_movement' | 'no_gps' | null } | null>, []>();
let mockLastFinalized: LastFinalized = null;
/** The store's newest row time (the row clock), or null before any row. */
let mockLastRowTs: number | null = null;
jest.mock('@/drive/useDrive', () => ({
  useDrive: <T,>(sel: (s: { lastFinalized: LastFinalized; status: DriveLive['status']; startedAt: number | null; lastRowTs: number | null }) => T) =>
    sel({ lastFinalized: mockLastFinalized, status: mockLive.status, startedAt: mockLive.startedAt, lastRowTs: mockLastRowTs }),
  useDriveLive: () => mockLive,
  useShownSpeed: () => mockShown,
  useDriveControls: () => ({ start: jest.fn(), end: mockEnd }),
  useDriveHost: () => ({ snapshot: () => ({ lastFinalized: mockLastFinalized }) }),
}));

const p = HUD.day;
/** The halo ring is hidden from assistive tech, so queries for it must ask for hidden elements. */
const HIDDEN = { includeHiddenElements: true };
/** What the halo was last told to show. */
const halo = (): HaloVisual => mockHalo.at(-1)!.visual;

/**
 * A test's view of the drive: `speedMph` is both the newest row's GPS speed (the halo's speeding
 * hold) and the speed the readout shows, standing for `speedAt` (the clock now when not given),
 * carried on with `speedAccelMph` (mph/s).
 */
type LiveOver = Partial<DriveLive> & { speedMph?: number | null; speedAccelMph?: number; speedAt?: number | null };

let lastShown: { speedMph: number | null; speedAccelMph: number; speedAt: number | null } = { speedMph: 34, speedAccelMph: 0, speedAt: null };

function split(over: LiveOver, base: typeof lastShown): { live: Partial<DriveLive>; shown: typeof lastShown } {
  const { speedMph, speedAccelMph, speedAt, ...rest } = over;
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

function live(over: Partial<DriveLive> = {}): DriveLive {
  return {
    status: 'recording',
    clientTripId: 't1',
    rowSpeedMph: 34,
    limitMph: 35,
    speedingTier: null,
    speedingRatio: null,
    speedingOver: false,
    courseDeg: null,
    lastDeduction: null,
    stopped: false,
    lastAlert: null,
    weatherAlert: null,
    points: null,
    startedAt: T,
    rowTs: null,
    phoneUseSince: null,
    ...over,
  };
}

async function renderHud(over: LiveOver = {}) {
  const first = split(over, { speedMph: 34, speedAccelMph: 0, speedAt: Date.now() });
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
  mockLastFinalized = null;
  mockEnd.mockResolvedValue({ clientTripId: 't1', dropped: null });
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
  // limit 35: the points line at 39 (T 4); the tint full red at 1.7 x 35 = 59.5; one row per second
  const at = (mph: number, line = 39, limit = 35) => ({ speedMph: mph, speedingRatio: mph / limit, speedingOver: mph > line });

  test('within the limit: calm, flowing, the speed white', async () => {
    await renderHud({ rowTs: T });
    expect(halo()).toMatchObject({ mode: 'calm', flow: true, pulsePeriodMs: 0 });
    // the numerals take the halo's colour at severity 0: the halo white (#F3F6FB), through Reanimated
    expect(p.haloInk).toBe('#F3F6FB');
    expect(JSON.stringify(screen.getByTestId('hud-speed-numeral').props.style)).toMatch(/rgba\(243, 246(\.\d+)?, 251, 1\)/);
    expect(screen.getByTestId('hud-halo', HIDDEN)).toBeTruthy();
  });

  test('past the limit, under the points line: a faint tint from the limit, still flowing, no pulse; spoken "over the limit"', async () => {
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
  ])('over the points line at %s mph: tinted %s from the limit, pulsing, no flow', async (mph, s) => {
    await renderHud({ rowTs: T, ...at(mph) });
    expect(halo().mode).toBe('speeding');
    expect(halo().severity).toBeCloseTo(s, 9);
    expect(halo().flow).toBe(false);
    expect(halo().pulsePeriodMs).toBeCloseTo(2200 - 1400 * s, 6);
  });

  test('the pulse stops on the first row back under the points line; the tint follows each row, calm at the limit', async () => {
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
    const two = Number(screen.getByTestId('hud-speed-numeral').props.style.flat?.(9).find((x: { fontSize?: number }) => x?.fontSize)?.fontSize ?? 0);
    await h.update({ speedMph: 70 }); // 113 km/h
    const three = Number(screen.getByTestId('hud-speed-numeral').props.style.flat?.(9).find((x: { fontSize?: number }) => x?.fontSize)?.fontSize ?? 0);
    expect(three).toBeGreaterThan(0);
    expect(three).toBeLessThan(two);
  });
});

describe('the shake when points come off', () => {
  const ded = (key: string, points: number, atTs: number) => ({ key, points, at: atTs });

  test('each new deduction shakes the ring once with its points; the same one again does not', async () => {
    const h = await renderHud({ rowTs: T });
    expect(halo().shake).toBeNull();
    await h.update({ rowTs: T + 1000, lastDeduction: ded('hard_brake:1', 20, T + 1000) });
    expect(halo().shake).toEqual({ key: `hard_brake:1@${T + 1000}`, points: 20 });
    await h.update({ rowTs: T + 1000, lastDeduction: ded('hard_brake:1', 20, T + 1000) });
    expect(halo().shake).toEqual({ key: `hard_brake:1@${T + 1000}`, points: 20 });
    await act(() => jest.advanceTimersByTime(1500));
    expect(halo().shake).toBeNull();
    await h.update({ rowTs: T + 9000, lastDeduction: ded('speeding:2', 5, T + 9000) });
    expect(halo().shake).toEqual({ key: `speeding:2@${T + 9000}`, points: 5 });
  });

  test('never for the one standing when the screen opens, nor for one 1.5 s old on the row clock (it came off in the background)', async () => {
    const h = await renderHud({ rowTs: T, lastDeduction: ded('hard_brake:1', 20, T) });
    expect(halo().shake).toBeNull();
    await h.update({ rowTs: T + 6000, lastDeduction: ded('phone_pickup:2', 32, T + 1000) });
    expect(halo().shake).toBeNull();
  });

  test('none under Reduce Motion', async () => {
    mockStill = true;
    const h = await renderHud({ rowTs: T });
    await h.update({ rowTs: T + 1000, lastDeduction: ded('hard_brake:1', 20, T + 1000) });
    expect(halo().shake).toBeNull();
  });
});

describe('the compass', () => {
  test('the halo is handed the GPS course; none before the first', async () => {
    const h = await renderHud({ rowTs: T });
    expect(mockHalo.at(-1)!.heading).toBeNull();
    expect(screen.getByTestId('hud-compass', HIDDEN)).toBeTruthy();
    await h.update({ rowTs: T + 1000, courseDeg: 270 });
    expect(mockHalo.at(-1)!.heading).toBe(270);
  });

  test('none in a compact window (no ring)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
    const dims = require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
    jest.spyOn(dims, 'default').mockReturnValue({ width: 400, height: 300, scale: 2, fontScale: 1 });
    await renderHud({ courseDeg: 90 });
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
    await renderHud({ weatherAlert: ICE, speedMph: 60, stopped: false });
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

  test('the ✕ shows and works at any speed, and hides it for the rest of the drive', async () => {
    const h = await renderHud({ weatherAlert: ICE, speedMph: 3, stopped: true });
    expect(screen.getByRole('button', { name: 'Hide weather alert' })).toBeOnTheScreen();
    await h.update({ speedMph: 70, stopped: false });
    const close = screen.getByRole('button', { name: 'Hide weather alert' });
    expect(close).not.toBeDisabled();
    expect(close).toHaveProp('accessibilityHint', 'Hides it for the rest of this drive.');
    // The drawn disc is small, the touch target is the HUD's 64 pt.
    const slop = close.props.hitSlop as number;
    expect(34 + 2 * slop).toBeGreaterThanOrEqual(HUD_MIN_TARGET_PT);
    await act(async () => {
      fireEvent.press(close);
    });
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    // Moving again, a fresh answer with the same danger: still hidden.
    await h.update({ speedMph: 40, stopped: false, weatherAlert: { ...ICE } });
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    // A different danger shows.
    await h.update({ weatherAlert: GUSTS });
    expect(screen.getByTestId('hud-weather')).toHaveTextContent(/Strong winds/);
    // The next drive starts with nothing hidden.
    await h.update({ clientTripId: 't2', weatherAlert: ICE });
    expect(screen.getByTestId('hud-weather')).toHaveTextContent(/Freezing rain/);
  });

  test('stopped with points and no line of their own: weather keeps the line until hidden, then the points take it', async () => {
    // A compact window (short and wide): the points share the band's line.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
    const dims = require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
    jest.spyOn(dims, 'default').mockReturnValue({ width: 400, height: 300, scale: 2, fontScale: 1 });
    await renderHud({ weatherAlert: ICE, stopped: true, speedMph: 0, points: { total: 40, sinceLastStop: 5 } });
    expect(screen.getByTestId('hud-weather')).toBeTruthy();
    expect(screen.queryByTestId('hud-points')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('hud-weather-close'));
    });
    expect(screen.queryByTestId('hud-weather')).toBeNull();
    expect(screen.getByTestId('hud-points')).toBeTruthy();
    jest.restoreAllMocks();
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
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: { key: `phone:hard_brake:${T + 1000}`, pulses: 3 } });
    await act(() => jest.advanceTimersByTime(1499));
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    await act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(halo().mode).toBe('calm');
  });

  test('a phone pickup bursts, then the halo holds the distraction while the episode lasts', async () => {
    const h = await renderHud({ rowTs: T, speedingTier: 'minor', speedMph: 41 });
    await h.update({ rowTs: T + 1000, phoneUseSince: T - 1000, lastAlert: { type: 'phone_pickup', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toHaveTextContent(/Phone/);
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1 });
    await act(() => jest.advanceTimersByTime(1500));
    expect(halo()).toMatchObject({ mode: 'distraction', severity: 0.65, burst: null });
    await h.update({ rowTs: T + 31_000, phoneUseSince: T - 1000, speedingTier: null });
    expect(halo().severity).toBeCloseTo(1, 6);
    await h.update({ rowTs: T + 32_000, phoneUseSince: null });
    expect(halo().mode).toBe('calm');
  });

  test('a speeding alert shows its words but never bursts', async () => {
    const h = await renderHud({ rowTs: T });
    await h.update({
      rowTs: T + 1000,
      speedingTier: 'minor',
      speedMph: 41,
      speedingRatio: 41 / 35,
      speedingOver: true,
      lastAlert: { type: 'speeding', tier: 'minor', at: T + 1000 },
    });
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
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

describe('points', () => {
  test('hidden while moving', async () => {
    await renderHud({ points: null });
    expect(screen.queryByTestId('hud-points')).toBeNull();
  });

  test('when stopped: the total and "pts", nothing about the change since the last stop', async () => {
    const h = await renderHud();
    await h.update({ stopped: true, speedMph: 0, points: { total: 1234, sinceLastStop: 12 } });
    expect(screen.getByTestId('hud-points')).toHaveTextContent('1,234 pts');
    expect(screen.getByLabelText('1,234 points')).toBeOnTheScreen();
    expect(screen.queryByText(/\+12/)).toBeNull();
  });

  test('pulling away from a stop with the speed unknown hides the points', async () => {
    const h = await renderHud({ stopped: true, speedMph: 0, points: { total: 10, sinceLastStop: 1 } });
    expect(screen.getByTestId('hud-points')).toBeTruthy();
    // The fix drops as the car pulls away: not stopped, speed "-", stale points still published.
    await h.update({ stopped: false, speedMph: null });
    expect(screen.queryByTestId('hud-points')).toBeNull();
  });

  test('landscape: the points sit inside the halo, under the speed; the band line stays free', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the hook behind react-native's export
    const dims = require('react-native/Libraries/Utilities/useWindowDimensions') as { default: () => unknown };
    jest.spyOn(dims, 'default').mockReturnValue({ width: 667, height: 375, scale: 2, fontScale: 1 });
    const h = await renderHud({ speedMph: 30 });
    expect(screen.getByTestId('hud-halo-stack')).toHaveStyle({ transform: [{ translateY: -33 }] });
    expect(screen.queryByTestId('hud-points')).toBeNull();
    await h.update({ stopped: true, speedMph: 0, points: { total: 1234, sinceLastStop: 0 } });
    expect(within(screen.getByTestId('hud-halo-points')).getByTestId('hud-points')).toHaveTextContent('1,234 pts');
    expect(screen.getByTestId('hud-points')).toHaveStyle({ fontSize: 28, width: 135 });
    expect(within(screen.getByTestId('hud-line')).queryByTestId('hud-points')).toBeNull();
    jest.restoreAllMocks();
  });

  test('gone again as the car moves off', async () => {
    const h = await renderHud({ stopped: true, points: { total: 10, sinceLastStop: 1 } });
    await h.update({ stopped: false, points: null });
    expect(screen.queryByTestId('hud-points')).toBeNull();
  });
});

describe('swipe to end', () => {
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

  test('End is the layout’s 76 pt capsule across the foot of the screen', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-end')).toHaveStyle({ height: END_SWIPE_H_PT });
  });

  test('a full swipe ends the drive and lands on its fresh summary', async () => {
    await renderHud({ speedMph: 60 });
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

  const drop = (clientTripId: string): LastFinalized => ({ clientTripId, ok: true, status: null, pointsNet: null, dropped: 'no_movement', endCause: 'stopped', at: T });

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
    mockLastFinalized = { clientTripId: 't1', ok: true, status: null, pointsNet: 12, dropped: null, endCause: 'stopped', at: T };
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
      mockLastFinalized = { clientTripId: 't1', ok: true, status: 'pending', pointsNet: 12, dropped: null, endCause: 'manual', at: T + 1 };
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

test('while moving, End, the navigation button and the weather ✕ are the only controls on the screen, the same as stopped', async () => {
  const fog = { kind: 'dense_fog', gustMph: null, visibilityM: 150 } as const;
  const h = await renderHud({ speedMph: 45, stopped: false });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav']);
  await h.update({ weatherAlert: fog });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav', 'hud-weather-close']);
  await h.update({ speedMph: 0, stopped: true, points: { total: 5, sinceLastStop: 0 } });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav', 'hud-weather-close']);
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

  test('the first tap at 25 mph opens the list of installed apps over the HUD; End still ends the drive with it open', async () => {
    await renderHud({ speedMph: 25 });
    await fireEvent.press(screen.getByTestId('hud-nav'));
    await act(async () => {});
    expect(screen.getByTestId('nav-picker')).toBeOnTheScreen();
    expect(screen.getByText('Select default navigation app')).toBeOnTheScreen();
    expect(screen.getByText('Opening it here never costs points. Leaving RoadWise any other way does.')).toBeOnTheScreen();
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

  test('a DashPal alert: its banner for 1.5 s per start or level change, over the phone event; the chip steps aside; a critical bursts red', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    const h = await renderHud({ rowTs: T, speedingTier: 'minor', speedMph: 41 });
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
    const h = await renderHud({ rowTs: T, speedMph: 52, speedingTier: 'severe', speedingRatio: 52 / 35, speedingOver: true });
    expect(halo()).toMatchObject({ mode: 'speeding', pulsePeriodMs: 0, flow: false });
    expect(halo().colorSeverity).toBeCloseTo((52 / 35 - 1) / 0.7, 9);
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: null });
    expect(screen.queryByTestId('hud-halo-flow', HIDDEN)).toBeNull();
  });

  test('not recording (saving): calm whatever the signals', async () => {
    await renderHud({ status: 'finalizing', rowTs: T, speedingTier: 'severe', speedMph: 90, speedingRatio: 2, speedingOver: true, phoneUseSince: T - 5000 });
    expect(halo().mode).toBe('calm');
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
    const bare = screen.getByTestId('hud-speed-numeral', HIDDEN).props.style;
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
    expect(JSON.stringify(screen.getByTestId('hud-speed-numeral', HIDDEN).props.style)).toContain(HUD[set].haloInk);
    expect(mockHalo.at(-1)!.palette.haloInk).toBe(HUD[set].haloInk);
    expect(set === 'night' || JSON.stringify(screen.getByTestId('hud-speed-numeral', HIDDEN).props.style) === JSON.stringify(bare)).toBe(true);
    expect(halo().mode).toBe('calm');
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
