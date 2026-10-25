import { act, render, screen } from '@testing-library/react-native';
import React, { useEffect } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SKY_BLEND_MS, ThemeProvider, useTheme, type Theme } from '@/ui/theme';
import { plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';
import { SkyBackdrop } from '@/ui/sky/SkyBackdrop';
import { CLEAR } from '@/ui/sky/weather';

const DAY: SkyMood = { phase: 'day', glow: 0, weather: CLEAR };
const NIGHT: SkyMood = { phase: 'night', glow: 0, weather: CLEAR };
const RAIN_DAY: SkyMood = { phase: 'day', glow: 0, weather: { kind: 'rain', intensity: 'moderate' } };

let seen: Theme | null = null;
let renders = 0;
// Memoised, as the app's screens are below the root: it renders only when the theme changes.
const Probe = React.memo(function Probe() {
  const t = useTheme();
  renders += 1;
  useEffect(() => {
    seen = t;
  });
  return <Text>{t.colors.bg}</Text>;
});

// The sky behind the tabs, still (no weather loops), so only the change of sky can be fading.
const themed = (mood: SkyMood | null, extra: { scheme?: 'light' | 'dark'; reduceMotion?: boolean } = {}) => (
  <SafeAreaProvider>
    <ThemeProvider mood={mood} {...extra}>
      <SkyBackdrop active={false} />
      <Probe />
    </ThemeProvider>
  </SafeAreaProvider>
);

beforeEach(() => {
  jest.useFakeTimers();
  seen = null;
  renders = 0;
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// The sky is hidden from screen readers, so the queries must look at hidden elements too.
const HIDDEN = { includeHiddenElements: true };
const fading = () => screen.queryAllByTestId('sky-fading', HIDDEN)[0] ?? null;
const grounds = () => screen.getAllByTestId('sky-ground', HIDDEN).map((g) => (g.props.style as { backgroundColor: string }[])[1]?.backgroundColor);

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

test('the first sky lands at once; a later change is one switch of the whole palette, as a transition, while the sky fades to it on the UI thread', async () => {
  const transition = jest.spyOn(React, 'startTransition');
  const view = await render(themed(DAY));
  const day = skyBundle(DAY);
  const night = skyBundle(NIGHT);
  expect(seen!.colors.bg).toBe(day.colors.bg);
  expect(seen!.scheme).toBe('light');
  expect(fading()).toBeNull();
  await tick(2000);
  expect(transition).not.toHaveBeenCalled();

  renders = 0;
  await view.rerender(themed(NIGHT));
  await tick(0);
  // One switch, in a transition that yields to every touch: the new palette is whole at once,
  // never a blend of the two, and the app renders it once.
  expect(transition).toHaveBeenCalledTimes(1);
  expect(seen!.colors.bg).toBe(night.colors.bg);
  expect(seen!.scheme).toBe('dark');
  expect(seen!.mood).toEqual(NIGHT);
  expect(renders).toBe(1);
  // The sky holds the old ground under the new one fading in; nothing lies over the app.
  expect(fading()).toBeOnTheScreen();
  expect(grounds()).toEqual([day.colors.bg, night.colors.bg]);
  // The fade costs the app no render.
  await tick(SKY_BLEND_MS);
  expect(renders).toBe(1);
  expect(fading()).toBeNull();
  expect(grounds()).toEqual([night.colors.bg]);
});

test('Reduce Motion lands a new sky at once, the sky included', async () => {
  const view = await render(themed(DAY, { reduceMotion: true }));
  await tick(2000);
  await view.rerender(themed(NIGHT, { reduceMotion: true }));
  expect(seen!.colors.bg).toBe(skyBundle(NIGHT).colors.bg);
  expect(fading()).toBeNull();
  expect(grounds()).toEqual([skyBundle(NIGHT).colors.bg]);
});

test('an equal mood in a new object changes nothing; a weather change does', async () => {
  const view = await render(themed(DAY));
  await tick(2000);
  const before = seen;
  renders = 0;
  await view.rerender(themed({ ...DAY, weather: { ...CLEAR } }));
  await tick(100);
  expect(seen).toBe(before);
  expect(fading()).toBeNull();

  await view.rerender(themed(RAIN_DAY));
  await tick(0);
  expect(seen!.colors.accent).toBe(skyBundle(RAIN_DAY).colors.accent);
  expect(fading()).toBeOnTheScreen();
});

test("the phone's scheme flipping under the sky (the sky sets it itself) starts no second change", async () => {
  const rn = jest.requireActual<typeof import('react-native')>('react-native');
  const spy = jest.spyOn(rn, 'useColorScheme').mockReturnValue('light');
  const view = await render(themed(DAY));
  await tick(2000);
  await view.rerender(themed(NIGHT));
  const after = seen;
  renders = 0;
  spy.mockReturnValue('dark');
  await view.rerender(themed(NIGHT));
  expect(seen).toBe(after);
  expect(renders).toBe(0);
  // The fade under way is left alone.
  expect(grounds()).toEqual([skyBundle(DAY).colors.bg, skyBundle(NIGHT).colors.bg]);
});

test('a new sky while one is fading starts again from the one fading in', async () => {
  const view = await render(themed(DAY));
  await tick(2000);
  await view.rerender(themed(NIGHT));
  await view.rerender(themed(RAIN_DAY));
  expect(seen!.colors.accent).toBe(skyBundle(RAIN_DAY).colors.accent);
  expect(grounds()).toEqual([skyBundle(NIGHT).colors.bg, skyBundle(RAIN_DAY).colors.bg]);
  await tick(SKY_BLEND_MS);
  expect(grounds()).toEqual([skyBundle(RAIN_DAY).colors.bg]);
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
  expect(fading()).toBeNull();
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
  expect(fading()).toBeNull();
  // Once back on the sky, a later change of sky fades again.
  await tick(2000);
  await view.rerender(themed(DAY));
  await tick(0);
  expect(fading()).toBeOnTheScreen();
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

