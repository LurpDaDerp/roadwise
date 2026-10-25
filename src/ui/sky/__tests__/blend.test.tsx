import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Text } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { useSnapshotBlocked } from '@/ui/snapshotGuard';

import { SKY_BLEND_MS, ThemeProvider, useTheme, type Theme } from '@/ui/theme';
import { plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';
import { CLEAR } from '@/ui/sky/weather';

jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
const capture = captureRef as jest.Mock;

const DAY: SkyMood = { phase: 'day', glow: 0, weather: CLEAR };
const NIGHT: SkyMood = { phase: 'night', glow: 0, weather: CLEAR };
const RAIN_DAY: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'rain', intensity: 'moderate' } };

let seen: Theme | null = null;
function Probe() {
  const t = useTheme();
  useEffect(() => {
    seen = t;
  });
  return <Text>{t.colors.bg}</Text>;
}

const themed = (mood: SkyMood | null, extra: { scheme?: 'light' | 'dark'; reduceMotion?: boolean } = {}) => (
  <ThemeProvider mood={mood} {...extra}>
    <Probe />
  </ThemeProvider>
);

beforeEach(() => {
  jest.useFakeTimers();
  seen = null;
  capture.mockReset().mockResolvedValue('data:image/jpg;base64,AAAA');
});
afterEach(() => {
  jest.useRealTimers();
});

// The snapshot is hidden from screen readers, so the queries must look at hidden elements too.
const HIDDEN = { includeHiddenElements: true };
const veil = () => screen.getByTestId('theme-veil', HIDDEN);

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

test('the first sky lands at once; a later change is one switch under a snapshot of the old look that fades out, light to dark included', async () => {
  const view = await render(themed(DAY));
  const day = skyBundle(DAY);
  const night = skyBundle(NIGHT);
  expect(seen!.colors.bg).toBe(day.colors.bg);
  expect(seen!.scheme).toBe('light');
  await tick(2000);

  await view.rerender(themed(NIGHT));
  await tick(0);
  // The old look was captured and is on screen; the new one waits for the image to be drawn.
  expect(capture).toHaveBeenCalledTimes(1);
  expect(veil()).toBeOnTheScreen();
  expect(seen!.colors.bg).toBe(day.colors.bg);
  await fireEvent(veil(), 'load');
  // One switch: the new palette is whole at once, never a blend of the two.
  expect(seen!.colors.bg).toBe(night.colors.bg);
  expect(seen!.scheme).toBe('dark');
  expect(seen!.mood).toEqual(NIGHT);
  const renders = seen;
  await tick(SKY_BLEND_MS * 0.5);
  expect(seen).toBe(renders);
  await tick(SKY_BLEND_MS);
  expect(screen.queryByTestId('theme-veil', HIDDEN)).toBeNull();
  expect(seen!.colors.bg).toBe(night.colors.bg);
});

test('a snapshot that cannot be taken, is too slow or will not draw lands the new sky at once', async () => {
  const view = await render(themed(DAY));
  await tick(2000);
  capture.mockRejectedValueOnce(new Error('no native module'));
  await view.rerender(themed(NIGHT));
  await tick(0);
  expect(seen!.colors.bg).toBe(skyBundle(NIGHT).colors.bg);
  expect(screen.queryByTestId('theme-veil', HIDDEN)).toBeNull();

  capture.mockReturnValueOnce(new Promise(() => {}));
  await view.rerender(themed(DAY));
  await tick(1000);
  expect(seen!.colors.bg).toBe(skyBundle(DAY).colors.bg);

  await view.rerender(themed(NIGHT));
  await tick(0);
  expect(veil()).toBeOnTheScreen();
  await tick(1100);
  expect(seen!.colors.bg).toBe(skyBundle(NIGHT).colors.bg);
});

test('Reduce Motion lands a new sky at once, without a snapshot', async () => {
  const view = await render(themed(DAY, { reduceMotion: true }));
  await tick(2000);
  await view.rerender(themed(NIGHT, { reduceMotion: true }));
  await tick(0);
  expect(capture).not.toHaveBeenCalled();
  expect(seen!.colors.bg).toBe(skyBundle(NIGHT).colors.bg);
});

test('an equal mood in a new object does not fade; a weather change does', async () => {
  const view = await render(themed(DAY));
  await tick(2000);
  const before = seen;
  await view.rerender(themed({ ...DAY, weather: { ...CLEAR } }));
  await tick(100);
  expect(seen!.colors).toBe(before!.colors);
  expect(capture).not.toHaveBeenCalled();

  await view.rerender(themed(RAIN_DAY));
  await tick(0);
  await fireEvent(veil(), 'load');
  expect(seen!.colors.accent).toBe(skyBundle(RAIN_DAY).colors.accent);
});

test('a new sky while one is fading drops the snapshot and starts again from what is on screen', async () => {
  const view = await render(themed(DAY));
  await tick(2000);
  await view.rerender(themed(NIGHT));
  await tick(0);
  await fireEvent(veil(), 'load');
  await tick(500);
  capture.mockResolvedValueOnce('data:image/jpg;base64,BBBB');
  await view.rerender(themed(RAIN_DAY));
  await tick(0);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(screen.getAllByTestId('theme-veil', HIDDEN)).toHaveLength(1);
  await fireEvent(veil(), 'load');
  expect(seen!.colors.accent).toBe(skyBundle(RAIN_DAY).colors.accent);
});

test('a pinned scheme switches at once and ignores the mood', async () => {
  const view = await render(themed(NIGHT, { scheme: 'light' }));
  expect(seen!.scheme).toBe('light');
  expect(seen!.mood).toBeNull();
  await view.rerender(
    <ThemeProvider scheme="dark">
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.scheme).toBe('dark');
  expect(capture).not.toHaveBeenCalled();
});

test('a switch from the sky to a static look lands at once, and back to the sky at once too, even after the sky had settled', async () => {
  const view = await render(themed(DAY));
  await tick(2000);
  await view.rerender(themed(null, { scheme: 'dark' }));
  expect(seen!.colors).toBe(plainBundle('dark').colors);
  expect(seen!.sky).toBe(plainBundle('dark').sky);
  expect(seen!.mood).toBeNull();
  await tick(2000);
  await view.rerender(themed(NIGHT));
  expect(seen!.colors.bg).toBe(skyBundle(NIGHT).colors.bg);
  expect(seen!.sky).toEqual(skyBundle(NIGHT).sky);
  expect(seen!.mood).toEqual(NIGHT);
  expect(capture).not.toHaveBeenCalled();
  // Once back on the sky, a later change of sky fades again.
  await tick(2000);
  await view.rerender(themed(DAY));
  await tick(0);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(veil()).toBeOnTheScreen();
});

test("the theme tells the driving screen its night: left to the sun under the sky, Light by day and Dark by night in a static look, the phone's scheme under System", async () => {
  const rn = jest.requireActual<typeof import('react-native')>('react-native');
  const view = await render(
    <ThemeProvider mood={NIGHT}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.hudNight).toBeNull();
  await view.rerender(
    <ThemeProvider scheme="light" mood={null}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.hudNight).toBe(false);
  await view.rerender(
    <ThemeProvider scheme="dark" mood={null}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.hudNight).toBe(true);
  const spy = jest.spyOn(rn, 'useColorScheme').mockReturnValue('dark');
  await view.rerender(
    <ThemeProvider mood={null}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.scheme).toBe('dark');
  expect(seen!.hudNight).toBe(true);
  spy.mockReturnValue('light');
  await view.rerender(
    <ThemeProvider mood={null}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.scheme).toBe('light');
  expect(seen!.hudNight).toBe(false);
  spy.mockRestore();
});

test('the snapshot is held in memory (a data uri, never a file), and none is taken while a screen that must not be copied is up', async () => {
  function Aim() {
    useSnapshotBlocked('test-aim');
    return null;
  }
  const view = await render(themed(DAY));
  await tick(2000);
  await view.rerender(themed(NIGHT));
  await tick(0);
  expect(capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'data-uri' }));
  await fireEvent(veil(), 'load');
  await tick(SKY_BLEND_MS + 100);

  capture.mockClear();
  const guarded = (mood: SkyMood) => (
    <ThemeProvider mood={mood}>
      <Probe />
      <Aim />
    </ThemeProvider>
  );
  await view.rerender(guarded(NIGHT));
  await view.rerender(guarded(DAY));
  await tick(0);
  expect(capture).not.toHaveBeenCalled();
  expect(screen.queryByTestId('theme-veil', HIDDEN)).toBeNull();
  expect(seen!.colors.bg).toBe(skyBundle(DAY).colors.bg);
});
