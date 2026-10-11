import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { DriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { DIM_AFTER_MS, HOLD_TO_END_MS, HUD } from '@/ui/drive';

import { hudCopy } from '../hudCopy';
import { HudScreen } from '../HudScreen';

const mockRouter = { replace: jest.fn(), push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn(async () => null) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

// The local settings mirror: `units` as WP9 writes it.
let mockUnits: 'mi' | 'km' | null = null;
const mockDb = {
  execute: jest.fn(async (_sql: string, params: unknown[]) => ({
    rows: params[0] === 'units' && mockUnits !== null ? [{ value_json: JSON.stringify(mockUnits) }] : [],
  })),
};
jest.mock('@/data/queries/context', () => ({ useDb: () => mockDb, useOptionalDb: () => mockDb }));

const T = 1_790_000_000_000;
let mockLive: DriveLive;
const mockEnd = jest.fn<Promise<{ clientTripId: string } | null>, []>();
jest.mock('@/drive/useDrive', () => ({
  useDriveLive: () => mockLive,
  useDriveControls: () => ({ start: jest.fn(), end: mockEnd }),
}));

const p = HUD.day;
/** The glow is hidden from assistive tech, so queries must ask for hidden elements. */
const HIDDEN = { includeHiddenElements: true };

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
  jest.clearAllMocks();
  mockUnits = null;
  mockEnd.mockResolvedValue({ clientTripId: 't1' });
});
afterEach(() => jest.useRealTimers());

describe('speed and limit', () => {
  test('the speed sits next to the limit sign', async () => {
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

describe('edge glow while speeding', () => {
  test('no glow while within the limit', async () => {
    await renderHud();
    expect(screen.queryByTestId('hud-glow', HIDDEN)).toBeNull();
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ color: p.ink });
  });

  test.each([
    ['minor', p.minor],
    ['moderate', p.moderate],
    ['severe', p.severe],
  ] as const)('%s: the edge and the numerals take the tier colour', async (tier, color) => {
    await renderHud({ speedMph: 50, speedingTier: tier });
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: color });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ color });
  });

  test('the glow ends with the episode', async () => {
    const h = await renderHud({ speedingTier: 'minor' });
    await h.update({ speedingTier: null });
    expect(screen.queryByTestId('hud-glow', HIDDEN)).toBeNull();
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
  test('a new alert shows its words and a glow in its tier colour for 1.5 s, then is gone', async () => {
    const h = await renderHud();
    await h.update({ lastAlert: { type: 'hard_brake', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toHaveTextContent(/Hard brake/);
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.severe });
    await act(() => jest.advanceTimersByTime(1499));
    expect(screen.getByTestId('hud-alert')).toBeTruthy();
    await act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(screen.queryByTestId('hud-glow', HIDDEN)).toBeNull();
  });

  test('the alert glow outranks the speeding glow while it shows', async () => {
    const h = await renderHud({ speedingTier: 'minor' });
    await h.update({ lastAlert: { type: 'phone_pickup', tier: 'severe', at: T + 1000 } });
    expect(screen.getByTestId('hud-alert')).toHaveTextContent(/Phone/);
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.severe });
    await act(() => jest.advanceTimersByTime(1500));
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.minor });
  });

  test('the alert already standing when the screen opens is not replayed', async () => {
    await renderHud({ lastAlert: { type: 'hard_brake', tier: 'minor', at: T } });
    expect(screen.queryByTestId('hud-alert')).toBeNull();
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

test('End is the only control on the screen', async () => {
  await renderHud({ weatherAlert: 'Dense fog', points: { total: 5, sinceLastStop: 0 }, stopped: true });
  expect(screen.getAllByRole('button')).toHaveLength(1);
});

describe('DashPal (plan §7.10)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the registry, after the mocks
  const { setActiveDashcam } = require('@/dashcam/registry') as typeof import('@/dashcam/registry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const { createFakeDashcamRuntime, PAIRED } = require('@/dashcam/__fixtures__/fakeRuntime') as typeof import('@/dashcam/__fixtures__/fakeRuntime');

  afterEach(() => setActiveDashcam(null));

  const visual = (o: { tier: number; sound: number; level?: number; id?: number }) => ({
    key: `${o.id ?? 1}:${o.level ?? 0}`,
    alertId: o.id ?? 1,
    sound: o.sound,
    tier: o.tier,
    level: o.level ?? 0,
    onPhone: true,
    at: Date.now(),
  });

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

  test('a DashPal alert: banner and glow for 1.5 s per start or level change; it outranks the phone event; a critical outranks its glow', async () => {
    const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
    setActiveDashcam(rt);
    const h = await renderHud({ speedingTier: 'minor' });
    await h.update({ lastAlert: { type: 'hard_brake', tier: 'moderate', at: T + 1000 } });
    await act(async () => rt.set({ link: { visual: visual({ tier: 3, sound: 3 }) } }));
    expect(screen.getByTestId('hud-dashpal-alert')).toHaveTextContent(/Wake up/);
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.severe });
    await act(() => jest.advanceTimersByTime(1500));
    expect(screen.queryByTestId('hud-dashpal-alert')).toBeNull();
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.minor });
    // A level change flashes again; a warning's glow yields to a phone event's.
    await act(async () => rt.set({ link: { visual: visual({ tier: 2, sound: 1, level: 1 }) } }));
    expect(screen.getByTestId('hud-dashpal-alert')).toHaveTextContent(/Eyes on the road/);
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.moderate });
    await h.update({ lastAlert: { type: 'phone_pickup', tier: 'severe', at: T + 5000 } });
    expect(screen.getByTestId('hud-dashpal-alert')).toBeTruthy();
    expect(screen.getByTestId('hud-glow', HIDDEN)).toHaveStyle({ borderColor: p.severe });
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
