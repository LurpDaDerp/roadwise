import { act, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SkyBackdrop, STORM_WASH } from '@/ui/sky/SkyBackdrop';
import type { SkyMood } from '@/ui/sky/palette';
import type { WeatherKind } from '@/ui/sky/weather';
import { ThemeProvider } from '@/ui/theme';

// Count the loops the weather layer starts: every one of them goes through withRepeat.
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual<Record<string, unknown>>('react-native-reanimated');
  const withRepeat = actual.withRepeat as (...a: unknown[]) => unknown;
  return { ...actual, __esModule: true, withRepeat: jest.fn((...a: unknown[]) => withRepeat(...a)) };
});
const { withRepeat } = jest.requireMock<{ withRepeat: jest.Mock }>('react-native-reanimated');

const mood = (phase: SkyMood['phase'], kind: WeatherKind): SkyMood => ({ phase, glow: 0, weather: { kind, intensity: 'moderate' } });

const sky = (m: SkyMood | null, opts: { still?: boolean; active?: boolean } = {}) =>
  render(
    <SafeAreaProvider>
      <ThemeProvider mood={m} reduceMotion={opts.still ?? false}>
        <SkyBackdrop active={opts.active ?? true} />
      </ThemeProvider>
    </SafeAreaProvider>
  );

const hidden = { includeHiddenElements: true };

// The loops run on timers; keep them on fake ones so none outlives its test.
beforeEach(() => {
  jest.useFakeTimers();
  withRepeat.mockClear();
});
afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

test.each(['cloudy', 'fog', 'rain', 'snow', 'storm'] as const)('%s weather draws its layer and keeps it moving', async (kind) => {
  await sky(mood('day', kind));
  expect(screen.getByTestId('sky-backdrop', hidden)).toBeOnTheScreen();
  expect(screen.getByTestId('sky-ambient', hidden)).toBeOnTheScreen();
  expect(withRepeat).toHaveBeenCalled();
});

test('a clear night twinkles; a clear day has only the sun glow and no weather layer', async () => {
  await sky(mood('night', 'clear'));
  expect(screen.getByTestId('sky-ambient', hidden)).toBeOnTheScreen();
  expect(withRepeat).toHaveBeenCalled();
  withRepeat.mockClear();
  await screen.unmount();
  await sky(mood('day', 'clear'));
  expect(screen.queryByTestId('sky-ambient', hidden)).toBeNull();
  expect(withRepeat).not.toHaveBeenCalled();
});

test('under Reduce Motion the weather layer is drawn but holds still: no loop starts', async () => {
  for (const kind of ['cloudy', 'fog', 'rain', 'snow', 'storm'] as const) {
    await sky(mood('dusk', kind), { still: true });
    expect(screen.getByTestId('sky-ambient', hidden)).toBeOnTheScreen();
    await screen.unmount();
  }
  await sky(mood('night', 'clear'), { still: true });
  expect(withRepeat).not.toHaveBeenCalled();
});

test('with its screen out of front, or with no mood (a pinned scheme), there is no weather layer', async () => {
  await sky(mood('day', 'rain'), { active: false });
  expect(screen.getByTestId('sky-backdrop', hidden)).toBeOnTheScreen();
  expect(screen.queryByTestId('sky-ambient', hidden)).toBeNull();
  await screen.unmount();
  await sky(null);
  expect(screen.queryByTestId('sky-ambient', hidden)).toBeNull();
  expect(withRepeat).not.toHaveBeenCalled();
});

test('a storm’s lightning is a slow wash, never a flash: long ramps, at most once every 8 s', () => {
  expect(STORM_WASH.upMs).toBeGreaterThanOrEqual(400);
  expect(STORM_WASH.downMs).toBeGreaterThanOrEqual(400);
  expect(STORM_WASH.gapMs + STORM_WASH.upMs + STORM_WASH.downMs).toBeGreaterThanOrEqual(8000);
});
