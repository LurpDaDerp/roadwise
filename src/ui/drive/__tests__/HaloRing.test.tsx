// The halo component (drive-screen design §5.7): the speed stays reachable for screen readers, the
// flow scales with the ring, nothing restarts on a target change, a burst plays once per key, and
// Reduce Motion drops every movement.
import { act, render, screen, within } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';

import { HALO_CALM, type HaloVisual } from '../halo';
import { COMPASS_DIM_LETTERS } from '../HaloCompass';
import { HALO_TIMINGS } from '../haloMotion';
import { Halo } from '../HaloRing';
import { HALO_DIM_OPACITY, HUD } from '../hudTokens';
import { SpeedReadout } from '../SpeedReadout';

const mockSequence = jest.fn();
const mockTiming = jest.fn();
const mockSetActive = jest.fn();
const mockFrameHooks = jest.fn();
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  const wrapped = new WeakMap<object, object>();
  return {
    ...actual,
    __esModule: true,
    default: actual.default,
    withSequence: (...a: unknown[]) => {
      mockSequence(...a);
      return actual.withSequence(...a);
    },
    withTiming: (...a: unknown[]) => {
      mockTiming(...a);
      return actual.withTiming(...a);
    },
    useFrameCallback: (cb: unknown, auto: unknown) => {
      mockFrameHooks();
      const real = actual.useFrameCallback(cb, auto) as Record<string, (v: boolean) => void>;
      // the same object for the same real one, so the hook's result is as stable as Reanimated's
      if (!wrapped.has(real)) {
        wrapped.set(real, {
          ...real,
          setActive: (v: boolean) => {
            mockSetActive(v);
            real['setActive']!(v);
          },
        });
      }
      return wrapped.get(real);
    },
  };
});

const p = HUD.day;
const HIDDEN = { includeHiddenElements: true };
const speeding = (s: number): HaloVisual => ({
  mode: 'speeding',
  severity: s,
  colorSeverity: s,
  pulsePeriodMs: 2200 - 1400 * s,
  pulseDepth: 0.3 + 0.4 * s,
  pulseScale: 0.015 + 0.02 * s,
  flow: false,
  burst: null,
  warning: true,
  shake: null,
});
const burst = (key: string): HaloVisual => ({
  ...HALO_CALM,
  mode: 'burst',
  colorSeverity: 1,
  flow: false,
  warning: true,
  burst: { key, severity: 1, pulses: 3, until: Date.now() + 1500 },
});
/** Tinted under the points line: the colour only, still flowing, no warning. */
const tint = (s: number): HaloVisual => ({ ...HALO_CALM, mode: 'speeding', severity: s, colorSeverity: s });
const shaking = (key: string, points: number): HaloVisual => ({ ...HALO_CALM, shake: { key, points } });

function view(visual: HaloVisual, o: { dimmed?: boolean; reduceMotion?: boolean; ring?: boolean; height?: number; heading?: number | null } = {}) {
  return (
    <Halo
      visual={visual}
      size={343}
      height={o.height}
      ring={o.ring ?? true}
      palette={p}
      dimmed={o.dimmed ?? false}
      reduceMotion={o.reduceMotion ?? false}
      heading={o.heading === undefined ? null : o.heading}
      numerals={(style) => <SpeedReadout speed={62} color={p.haloInk} unitColor={p.haloInkMuted} size={157} numeralStyle={style} speeding />}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test('the speed stays reachable for screen readers; the ring is hidden from them', async () => {
  await render(view(HALO_CALM));
  expect(screen.getByLabelText('Speed 62 miles per hour, over the limit')).toBeTruthy();
  expect(screen.queryByTestId('hud-halo')).toBeNull();
  expect(screen.getByTestId('hud-halo', HIDDEN)).toBeTruthy();
});

test('the flow sits inside the pulse view (it scales with the ring); none under Reduce Motion', async () => {
  const r = await render(view(HALO_CALM));
  const pulse = screen.getByTestId('hud-halo-pulse', HIDDEN);
  expect(within(pulse).getByTestId('hud-halo-flow', HIDDEN)).toBeTruthy();
  await r.rerender(view(HALO_CALM, { reduceMotion: true }));
  expect(screen.queryByTestId('hud-halo-flow', HIDDEN)).toBeNull();
  expect(mockSetActive).toHaveBeenLastCalledWith(false);
});

test('Android texture: the pulse view is cached only while it pulses or bursts, never while the flow turns inside it', async () => {
  const pulse = () => screen.getByTestId('hud-halo-pulse', HIDDEN).props.renderToHardwareTextureAndroid;
  const flow = () => screen.getByTestId('hud-halo-flow', HIDDEN).props.renderToHardwareTextureAndroid;
  const r = await render(view(HALO_CALM));
  expect(pulse()).toBe(false);
  expect(flow()).toBe(true);
  await r.rerender(view(speeding(0.5)));
  expect(pulse()).toBe(true);
  await r.rerender(view(burst('phone:hard_brake:2')));
  expect(pulse()).toBe(true);
  await r.rerender(view({ ...speeding(0.5), pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0 }, { reduceMotion: true }));
  expect(pulse()).toBe(false);
});

test('a severity wobbling within a tier for 10 rows restarts nothing: no burst, the clock started once', async () => {
  const r = await render(view(speeding(0.3)));
  for (let i = 0; i < 10; i += 1) await r.rerender(view(speeding(0.3 + (i % 3) * 0.04)));
  expect(mockSequence).not.toHaveBeenCalled();
  expect(mockSetActive.mock.calls).toEqual([[true]]);
  expect(mockFrameHooks.mock.calls.length).toBeGreaterThanOrEqual(11); // one hook, read each render
});

test('a burst plays once per key: the same key over 5 renders once, a new key again', async () => {
  const r = await render(view(burst('phone:hard_brake:1')));
  for (let i = 0; i < 5; i += 1) await r.rerender(view(burst('phone:hard_brake:1')));
  expect(mockSequence).toHaveBeenCalledTimes(1);
  expect(mockSequence.mock.calls[0]).toHaveLength(6); // three pulses, up and down
  await r.rerender(view(burst('dashpal:2:1:0')));
  expect(mockSequence).toHaveBeenCalledTimes(2);
});

test('a burst of one pulse is one up and one down', async () => {
  const v = burst('dashpal:3:1:0');
  await render(view({ ...v, burst: { ...v.burst!, pulses: 1 } }));
  expect(mockSequence.mock.calls[0]).toHaveLength(2);
});

test('dimmed and calm: reduced strength, still flowing; a warning: full strength', async () => {
  const r = await render(view(HALO_CALM, { dimmed: true }));
  expect(mockTiming).toHaveBeenCalledWith(HALO_DIM_OPACITY, HALO_TIMINGS.layer);
  expect(mockSetActive).toHaveBeenLastCalledWith(true);
  mockTiming.mockClear();
  await r.rerender(view(speeding(0.5), { dimmed: true }));
  expect(mockTiming).toHaveBeenCalledWith(1, HALO_TIMINGS.layer);
});

test('dimmed with a tint under the points line: still reduced strength (a faint tint is not a warning)', async () => {
  const r = await render(view(HALO_CALM, { dimmed: true }));
  mockTiming.mockClear();
  await r.rerender(view(tint(0.15), { dimmed: true }));
  expect(mockTiming).not.toHaveBeenCalledWith(1, HALO_TIMINGS.layer);
  expect(mockSetActive).toHaveBeenLastCalledWith(true);
});

test('a shake plays once per key, swinging through its offsets; the same key over renders never again', async () => {
  const r = await render(view(shaking('hard_brake:1@5', 20)));
  for (let i = 0; i < 4; i += 1) await r.rerender(view(shaking('hard_brake:1@5', 20)));
  expect(mockSequence).toHaveBeenCalledTimes(1);
  expect(mockSequence.mock.calls[0]).toHaveLength(5); // four swings and back to rest
  expect(mockTiming).toHaveBeenCalledWith(0, HALO_TIMINGS.shakeSwing);
  await r.rerender(view(shaking('speeding:2@9', 80)));
  expect(mockSequence).toHaveBeenCalledTimes(2);
  expect(mockSequence.mock.calls[1]).toHaveLength(7);
  await r.rerender(view(HALO_CALM));
  expect(mockSequence).toHaveBeenCalledTimes(2);
});

describe('the compass', () => {
  const rotation = () => (getAnimatedStyle(screen.getByTestId('hud-compass-card', HIDDEN)) as { transform: { rotate: string }[] }).transform[0]!.rotate;

  test('around the ring, outside the pulse view (it never grows, fades or shakes); hidden from screen readers with the ring', async () => {
    await render(view(speeding(0.5), { heading: 90 }));
    const compass = screen.getByTestId('hud-compass', HIDDEN);
    const pulse = screen.getByTestId('hud-halo-pulse', HIDDEN);
    expect(within(pulse).queryByTestId('hud-compass', HIDDEN)).toBeNull();
    expect(within(screen.getByTestId('hud-halo', HIDDEN)).getByTestId('hud-compass', HIDDEN)).toBe(compass);
    expect(screen.queryByTestId('hud-compass')).toBeNull();
    for (const l of ['N', 'E', 'S', 'W']) expect(within(compass).getByText(l, HIDDEN)).toBeTruthy();
  });

  test('none without a ring', async () => {
    await render(view(HALO_CALM, { ring: false, heading: 90 }));
    expect(screen.queryByTestId('hud-compass', HIDDEN)).toBeNull();
  });

  test('heading up: the card turns the other way by the course, the short way round, in 700 ms; letters upright, placed by bearing', async () => {
    const r = await render(view(HALO_CALM, { heading: 350 }));
    await act(() => jest.advanceTimersByTime(1000));
    expect(rotation()).toBe('-350deg');
    mockTiming.mockClear();
    await r.rerender(view(HALO_CALM, { heading: 10 }));
    expect(mockTiming).toHaveBeenCalledWith(-370, HALO_TIMINGS.compass);
    await act(() => jest.advanceTimersByTime(1000));
    expect(rotation()).toBe('-370deg');
    // heading 10: N sits 10 degrees left of the top, moved there without turning
    const n = getAnimatedStyle(screen.getByTestId('hud-compass-N', HIDDEN)) as { transform: Record<string, number>[] };
    expect(n.transform[0]!['translateX']).toBeLessThan(0);
    expect(n.transform[1]!['translateY']).toBeLessThan(0);
    expect(n.transform.some((t) => 'rotate' in t)).toBe(false);
  });

  test('no course yet: the ticks with the letters dimmed; a lost course holds the card where it was', async () => {
    const r = await render(view(HALO_CALM, { heading: null }));
    expect(screen.getByTestId('hud-compass-N', HIDDEN)).toHaveStyle({ opacity: COMPASS_DIM_LETTERS });
    await r.rerender(view(HALO_CALM, { heading: 45 }));
    expect(screen.getByTestId('hud-compass-N', HIDDEN)).toHaveStyle({ opacity: 1 });
    await act(() => jest.advanceTimersByTime(1000));
    mockTiming.mockClear();
    await r.rerender(view(HALO_CALM, { heading: null }));
    expect(mockTiming).not.toHaveBeenCalledWith(expect.anything(), HALO_TIMINGS.compass);
    expect(rotation()).toBe('-45deg');
  });

  test('N in the halo ink, the other letters muted (never red)', async () => {
    await render(view(HALO_CALM, { heading: 0 }));
    const color = (l: string) => StyleSheet.flatten(within(screen.getByTestId(`hud-compass-${l}`, HIDDEN)).getByText(l, HIDDEN).props.style).color;
    expect(color('N')).toBe(p.haloInk);
    for (const l of ['E', 'S', 'W']) expect(color(l)).toBe(p.haloInkMuted);
  });

  test('Reduce Motion: the card snaps to each course', async () => {
    const r = await render(view(HALO_CALM, { heading: 0, reduceMotion: true }));
    mockTiming.mockClear();
    await r.rerender(view(HALO_CALM, { heading: 120, reduceMotion: true }));
    expect(mockTiming).not.toHaveBeenCalledWith(expect.anything(), HALO_TIMINGS.compass);
    await act(() => jest.advanceTimersByTime(20)); // the next frame
    expect(rotation()).toBe('-120deg');
  });
});

test('a distraction warning (driver not visible among them) runs the clock: it pulses', async () => {
  await render(view({ ...speeding(0.5), mode: 'distraction' }));
  expect(mockSetActive.mock.calls).toEqual([[true]]);
});

test('Reduce Motion: colours fade (250 ms), the clock never runs, a burst never pulses', async () => {
  const r = await render(view(HALO_CALM, { reduceMotion: true }));
  mockTiming.mockClear();
  await r.rerender(view({ ...speeding(0.6), pulsePeriodMs: 0, pulseDepth: 0, pulseScale: 0 }, { reduceMotion: true }));
  expect(mockTiming).toHaveBeenCalledWith(0.6, HALO_TIMINGS.reduceColor);
  await r.rerender(view({ ...burst('k'), burst: null }, { reduceMotion: true }));
  expect(mockSequence).not.toHaveBeenCalled();
  expect(mockSetActive.mock.calls.every(([v]) => v === false)).toBe(true);
});

test('no ring in a small window: the numerals alone, still in the halo colour', async () => {
  await render(view(speeding(0.5), { ring: false }));
  expect(screen.queryByTestId('hud-halo', HIDDEN)).toBeNull();
  expect(screen.getByTestId('hud-speed-numeral')).toBeTruthy();
});

test('no ring: the numerals box takes its own height; with a ring the box stays square', async () => {
  const layer = () => StyleSheet.flatten(screen.getByTestId('hud-halo-layer').props.style);
  const r = await render(view(HALO_CALM, { ring: false, height: 90 }));
  expect(layer()).toMatchObject({ width: 343, height: 90 });
  await r.rerender(view(HALO_CALM, { ring: true, height: 90 }));
  expect(layer()).toMatchObject({ width: 343, height: 343 });
});

test('unmounting mid-burst leaves no timer of its own behind', async () => {
  // the test environment keeps one global timer of its own (a plain View leaves it too)
  const base = await render(<View />);
  await base.unmount();
  await act(() => jest.advanceTimersByTime(5000));
  const baseline = jest.getTimerCount();
  const r = await render(view(burst('phone:hard_corner:9')));
  await act(() => jest.advanceTimersByTime(100));
  await r.unmount();
  await act(() => jest.advanceTimersByTime(5000));
  expect(jest.getTimerCount()).toBe(baseline);
});
