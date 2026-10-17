import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { LastFinalized } from '@/drive/host';
import type { DriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { DIM_AFTER_MS, HOLD_TO_END_MS, HUD, type HaloProps, type HaloVisual } from '@/ui/drive';
import type { SkyMood } from '@/ui/sky/palette';
import { ThemeProvider } from '@/ui/theme';

import { hudCopy } from '../hudCopy';
import { HudScreen } from '../HudScreen';

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

const mockRouter = { replace: jest.fn(), push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn(async () => null) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

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
let mockLive: DriveLive;
const mockEnd = jest.fn<Promise<{ clientTripId: string; dropped: 'no_movement' | 'no_gps' | null } | null>, []>();
let mockLastFinalized: LastFinalized = null;
/** The store's newest row time (the row clock), or null before any row. */
let mockLastRowTs: number | null = null;
jest.mock('@/drive/useDrive', () => ({
  useDrive: <T,>(sel: (s: { lastFinalized: LastFinalized; status: DriveLive['status']; startedAt: number | null; lastRowTs: number | null }) => T) =>
    sel({ lastFinalized: mockLastFinalized, status: mockLive.status, startedAt: mockLive.startedAt, lastRowTs: mockLastRowTs }),
  useDriveLive: () => mockLive,
  useDriveControls: () => ({ start: jest.fn(), end: mockEnd }),
  useDriveHost: () => ({ snapshot: () => ({ lastFinalized: mockLastFinalized }) }),
}));

const p = HUD.day;
/** The halo ring is hidden from assistive tech, so queries for it must ask for hidden elements. */
const HIDDEN = { includeHiddenElements: true };
/** What the halo was last told to show. */
const halo = (): HaloVisual => mockHalo.at(-1)!.visual;

function live(over: Partial<DriveLive> = {}): DriveLive {
  return {
    status: 'recording',
    clientTripId: 't1',
    speedMph: 34,
    limitMph: 35,
    speedingTier: null,
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

async function renderHud(over: Partial<DriveLive> = {}) {
  mockLive = live(over);
  const r = await render(<HudScreen />);
  await act(async () => {}); // the units read
  return {
    async update(next: Partial<DriveLive>) {
      mockLive = { ...mockLive, ...next };
      await r.rerender(<HudScreen />);
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  jest.clearAllMocks();
  mockHalo.length = 0;
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

  test('km: an unknown limit is still "—"', async () => {
    mockUnits = 'km';
    await renderHud({ limitMph: null });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
  });

  test('an unknown speed or limit is "—"', async () => {
    await renderHud({ speedMph: null, limitMph: null });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('—');
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
  });
});

describe('the halo while speeding (design §4.1)', () => {
  // limit 35: T = 5, L + T = 40; one row per second on the row clock
  async function drive(rows: Partial<DriveLive>[]) {
    const h = await renderHud({ rowTs: T, ...rows[0] });
    for (let i = 1; i < rows.length; i += 1) await h.update({ rowTs: T + i * 1000, ...rows[i] });
    return h;
  }

  test('within the limit: calm, flowing, the speed white', async () => {
    await renderHud({ rowTs: T });
    expect(halo()).toMatchObject({ mode: 'calm', flow: true, pulsePeriodMs: 0 });
    // the numerals take the halo's colour at severity 0: the halo white (#F3F6FB), through Reanimated
    expect(p.haloInk).toBe('#F3F6FB');
    expect(JSON.stringify(screen.getByTestId('hud-speed-numeral').props.style)).toMatch(/rgba\(243, 246(\.\d+)?, 251, 1\)/);
    expect(screen.getByTestId('hud-halo', HIDDEN)).toBeTruthy();
  });

  test.each([
    ['minor', 40.1, 0.3035],
    ['moderate', 47, 0.545],
    ['severe', 55, 0.825],
  ] as const)('%s at %s mph: speeding at about %s, pulsing, no flow', async (tier, speedMph, s) => {
    await renderHud({ rowTs: T, speedMph, speedingTier: tier });
    expect(halo().mode).toBe('speeding');
    expect(halo().severity).toBeCloseTo(s, 4);
    expect(halo().flow).toBe(false);
    expect(halo().pulsePeriodMs).toBeCloseTo(2200 - 1400 * s, 3);
  });

  test('back under 38 mph: calm again on the 5th row', async () => {
    await drive([{ speedMph: 47, speedingTier: 'moderate' }, ...Array(4).fill({ speedMph: 30, speedingTier: null })]);
    expect(halo().mode).toBe('speeding');
    await drive([{ speedMph: 47, speedingTier: 'moderate' }, ...Array(5).fill({ speedMph: 30, speedingTier: null })]);
    expect(halo().mode).toBe('calm');
  });

  test('no flicker at the line: 75.1 / 74.9 against L + T = 75 for 30 rows enters once and never returns to calm; the scrim ignores it', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? { speedMph: 75.1, limitMph: 65, speedingTier: 'minor' as const } : { speedMph: 74.9, limitMph: 65, speedingTier: null }
    );
    const h = await renderHud({ rowTs: T - 1000, speedMph: 70, limitMph: 65 });
    expect(halo().mode).toBe('calm');
    const modes: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      await h.update({ rowTs: T + i * 1000, ...rows[i] });
      modes.push(halo().mode);
      if (i === 12) await act(() => jest.advanceTimersByTime(DIM_AFTER_MS));
    }
    expect(modes.every((m) => m === 'speeding')).toBe(true);
    expect(halo().severity).toBeGreaterThanOrEqual(0.3);
    expect(halo().severity).toBeLessThanOrEqual(0.31);
    // dimmed after 10 s without a touch, whatever the halo does
    expect(screen.getByTestId('hud-dim')).toBeTruthy();
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

test('weather: a one-line banner only while an alert is active', async () => {
  const h = await renderHud();
  expect(screen.queryByTestId('hud-weather')).toBeNull();
  await h.update({ weatherAlert: 'Icy rain' });
  expect(screen.getByTestId('hud-weather')).toHaveTextContent(/Icy rain/);
  await h.update({ weatherAlert: null });
  expect(screen.queryByTestId('hud-weather')).toBeNull();
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
    await h.update({ rowTs: T + 1000, speedingTier: 'minor', speedMph: 41, lastAlert: { type: 'speeding', tier: 'minor', at: T + 1000 } });
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

  test('when stopped: the total and a green gain since the last stop', async () => {
    const h = await renderHud();
    await h.update({ stopped: true, speedMph: 0, points: { total: 1234, sinceLastStop: 12 } });
    expect(screen.getByTestId('hud-points')).toHaveTextContent(/1,234/);
    expect(screen.getByTestId('hud-points-change')).toHaveTextContent('+12');
    expect(screen.getByTestId('hud-points-change')).toHaveStyle({ color: p.gain });
  });

  test('a loss shows red with a true minus sign', async () => {
    await renderHud({ stopped: true, speedMph: 0, points: { total: 980, sinceLastStop: -8 } });
    expect(screen.getByTestId('hud-points-change')).toHaveTextContent('−8');
    expect(screen.getByTestId('hud-points-change')).toHaveStyle({ color: p.severe });
  });

  test('pulling away from a stop with the speed unknown hides the points', async () => {
    const h = await renderHud({ stopped: true, speedMph: 0, points: { total: 10, sinceLastStop: 1 } });
    expect(screen.getByTestId('hud-points')).toBeTruthy();
    // The fix drops as the car pulls away: not stopped, speed "—", stale points still published.
    await h.update({ stopped: false, speedMph: null });
    expect(screen.queryByTestId('hud-points')).toBeNull();
  });

  test('gone again as the car moves off', async () => {
    const h = await renderHud({ stopped: true, points: { total: 10, sinceLastStop: 1 } });
    await h.update({ stopped: false, points: null });
    expect(screen.queryByTestId('hud-points')).toBeNull();
  });
});

describe('hold to end', () => {
  test('letting go early cancels: the drive goes on', async () => {
    await renderHud();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await fireEvent(end, 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS - 50));
    await fireEvent(end, 'pressOut');
    await act(() => jest.advanceTimersByTime(2000));
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('a full hold ends the drive and lands on its fresh summary', async () => {
    await renderHud({ speedMph: 60 });
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await fireEvent(end, 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/(app)/drives/[clientTripId]',
      params: { clientTripId: 't1', fresh: '1' },
    });
  });

  test('with no drive to end it goes Home', async () => {
    mockEnd.mockResolvedValue(null);
    await renderHud({ status: 'idle', clientTripId: null });
    await fireEvent(screen.getByRole('button', { name: hudCopy.endLabel }), 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    expect(mockRouter.replace).toHaveBeenCalledWith(HOME_HREF);
  });

  test('a drive that auto-ends lands on its summary once', async () => {
    const h = await renderHud();
    await h.update({ status: 'finalizing' });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
  });

  const drop = (clientTripId: string): LastFinalized => ({ clientTripId, ok: true, status: null, pointsNet: null, dropped: 'no_movement', endCause: 'stopped', at: T });

  test('a drive that ended by itself and was not kept lands on Home once, not on a summary', async () => {
    const h = await renderHud();
    await h.update({ status: 'finalizing' });
    mockLastFinalized = drop('t1');
    await h.update({ status: 'idle', clientTripId: null });
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(HOME_HREF);
  });

  test('a hold that ends a drive that was not kept (or lands during its automatic drop) goes Home once', async () => {
    mockEnd.mockResolvedValue({ clientTripId: 't1', dropped: 'no_movement' });
    const h = await renderHud();
    await fireEvent(screen.getByRole('button', { name: hudCopy.endLabel }), 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    mockLastFinalized = drop('t1');
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(HOME_HREF);
  });

  test('a hold that lands after the drive dropped itself, before this screen saw it go idle, goes Home', async () => {
    // The engine is already idle with this drive dropped (end() finds no drive), but the screen
    // still shows it recording, so the render-time drop id is stale.
    await renderHud();
    mockEnd.mockResolvedValue(null);
    mockLastFinalized = drop('t1');
    await fireEvent(screen.getByRole('button', { name: hudCopy.endLabel }), 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(HOME_HREF);
  });

  test('a hold that lands after the drive ended by itself and was kept goes to its summary', async () => {
    await renderHud();
    mockEnd.mockResolvedValue(null);
    mockLastFinalized = { clientTripId: 't1', ok: true, status: null, pointsNet: 12, dropped: null, endCause: 'stopped', at: T };
    await fireEvent(screen.getByRole('button', { name: hudCopy.endLabel }), 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
  });

  test('an older drive’s drop does not send this kept drive Home', async () => {
    mockLastFinalized = drop('old');
    const h = await renderHud();
    await h.update({ status: 'idle', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
  });

  test('a failed end says "Hold again" and lets the driver hold again', async () => {
    mockEnd.mockRejectedValueOnce(new Error('busy'));
    await renderHud();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await fireEvent(end, 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    expect(screen.getByTestId('hud-end-failed')).toHaveTextContent(hudCopy.endFailed);
    expect(hudCopy.endFailed.split(/\s+/).length).toBeLessThanOrEqual(3);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(end).not.toBeDisabled();

    await fireEvent(end, 'pressOut');
    await fireEvent(end, 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
    expect(screen.queryByTestId('hud-end-failed')).toBeNull();
    expect(mockRouter.replace).toHaveBeenCalledWith(driveSummaryHref('t1', true));
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

test('End and the navigation button are the only controls on the screen', async () => {
  await renderHud({ weatherAlert: 'Dense fog', points: { total: 5, sinceLastStop: 0 }, stopped: true });
  expect(screen.getAllByRole('button').map((b) => b.props.testID).sort()).toEqual(['hud-end', 'hud-nav']);
});

describe('the navigation button (design §7.4, §8)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the RN module the default port uses, after the mocks
  const { Linking } = require('react-native') as typeof import('react-native');
  beforeEach(() => {
    jest.spyOn(Linking, 'canOpenURL').mockImplementation(async (url: string) => url === 'waze://' || url === 'maps://');
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  test('it shows while moving, with "Navigate" and no highlight when no app is saved', async () => {
    await renderHud({ speedMph: 60 });
    expect(screen.getByTestId('hud-nav')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Choose a navigation app' })).toBeOnTheScreen();
    expect(screen.getByText('Navigate')).toBeOnTheScreen();
    expect(screen.queryByTestId('hud-nav-highlight')).toBeNull();
  });

  test('the first tap at 60 mph opens the list of installed apps over the HUD; End still ends the drive with it open', async () => {
    await renderHud({ speedMph: 60 });
    await fireEvent.press(screen.getByTestId('hud-nav'));
    await act(async () => {});
    expect(screen.getByTestId('nav-picker')).toBeOnTheScreen();
    expect(screen.getByText('Select default navigation app')).toBeOnTheScreen();
    expect(screen.getByText('Opening it with this button never costs points. Leaving RoadWise any other way during a drive does.')).toBeOnTheScreen();
    expect(screen.getByTestId('nav-picker-row-apple_maps')).toBeOnTheScreen();
    expect(screen.getByTestId('nav-picker-row-waze')).toBeOnTheScreen();
    // the screen does not dim under the list
    await act(() => jest.advanceTimersByTime(DIM_AFTER_MS + 1000));
    expect(screen.queryByTestId('hud-dim')).toBeNull();
    const end = screen.getByRole('button', { name: hudCopy.endLabel });
    await fireEvent(end, 'pressIn');
    await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS));
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

  test('disabled while the drive is saving', async () => {
    await renderHud({ status: 'finalizing' });
    expect(screen.getByTestId('hud-nav').props.accessibilityState).toMatchObject({ disabled: true });
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

  test('the bottom row holds the sign, End and the navigation button', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-limit')).toBeTruthy();
    expect(screen.getByTestId('hud-end')).toBeTruthy();
    expect(screen.getByTestId('hud-nav')).toBeTruthy();
  });

  test('Reduce Motion: no pulse, no flow, colours unchanged, a burst as colour only', async () => {
    mockStill = true;
    const h = await renderHud({ rowTs: T, speedMph: 55, speedingTier: 'severe' });
    expect(halo()).toMatchObject({ mode: 'speeding', pulsePeriodMs: 0, flow: false });
    expect(halo().colorSeverity).toBeCloseTo(0.825, 4);
    await h.update({ rowTs: T + 1000, lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(halo()).toMatchObject({ mode: 'burst', colorSeverity: 1, burst: null });
    expect(screen.queryByTestId('hud-halo-flow', HIDDEN)).toBeNull();
  });

  test('not recording (saving): calm whatever the signals', async () => {
    await renderHud({ status: 'finalizing', rowTs: T, speedingTier: 'severe', speedMph: 90, phoneUseSince: T - 5000 });
    expect(halo().mode).toBe('calm');
  });
});

// Jest compiles this suite to CommonJS, so `__dirname` is real at run time.
declare const __dirname: string;

describe('the sky theme stays off the driving screen', () => {
  const STORM_AT_DUSK: SkyMood = { phase: 'dusk', glow: 1, weather: { kind: 'storm', intensity: 'heavy' } };
  const RAIN_BY_DAY: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'rain', intensity: 'heavy' } };

  test.each([
    ['a storm at dusk', STORM_AT_DUSK],
    ['heavy rain by day', RAIN_BY_DAY],
  ])('under %s: no backdrop, no weather layer, and the speed reads in the HUD palette exactly as without a sky', async (_name, mood) => {
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
    expect(screen.queryByTestId('sky-backdrop', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('sky-ambient', HIDDEN)).toBeNull();
    expect(screen.getByTestId('hud-speed-numeral', HIDDEN).props.style).toEqual(bare);
    expect(halo().mode).toBe('calm');
  });

  test('no driving-screen source reaches for the sky theme', () => {
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
