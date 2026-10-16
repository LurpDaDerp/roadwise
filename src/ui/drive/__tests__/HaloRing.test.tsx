// The halo component (drive-screen design §5.7): the speed stays reachable for screen readers, the
// flow scales with the ring, nothing restarts on a target change, a burst plays once per key, and
// Reduce Motion drops every movement.
import { act, render, screen, within } from '@testing-library/react-native';
import { View } from 'react-native';

import { HALO_CALM, type HaloVisual } from '../halo';
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
  steady: false,
});
const burst = (key: string): HaloVisual => ({ ...HALO_CALM, mode: 'burst', colorSeverity: 1, flow: false, burst: { key, severity: 1, pulses: 3, until: Date.now() + 1500 } });

function view(visual: HaloVisual, o: { dimmed?: boolean; reduceMotion?: boolean; ring?: boolean } = {}) {
  return (
    <Halo
      visual={visual}
      size={343}
      ring={o.ring ?? true}
      palette={p}
      dimmed={o.dimmed ?? false}
      reduceMotion={o.reduceMotion ?? false}
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

test('driver not visible (steady): the clock stops, nothing moves', async () => {
  const steady: HaloVisual = { ...HALO_CALM, mode: 'distraction', severity: 0.35, colorSeverity: 0.35, flow: false, steady: true };
  await render(view(steady));
  expect(mockSetActive.mock.calls).toEqual([[false]]);
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
