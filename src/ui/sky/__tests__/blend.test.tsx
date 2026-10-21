import { act, render } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Text } from 'react-native';

import { SKY_BLEND_MS, ThemeProvider, useTheme, type Theme } from '@/ui/theme';
import { plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';
import { CLEAR } from '@/ui/sky/weather';

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

beforeEach(() => {
  jest.useFakeTimers();
  seen = null;
});
afterEach(() => {
  jest.useRealTimers();
});

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

test('the first sky lands at once; later changes blend over a couple of seconds, light to dark included', async () => {
  const view = await render(
    <ThemeProvider mood={DAY}>
      <Probe />
    </ThemeProvider>
  );
  const day = skyBundle(DAY);
  const night = skyBundle(NIGHT);
  expect(seen!.colors.bg).toBe(day.colors.bg);
  expect(seen!.scheme).toBe('light');
  await tick(2000);

  await view.rerender(
    <ThemeProvider mood={NIGHT}>
      <Probe />
    </ThemeProvider>
  );
  // Still the day palette: the blend starts on the next frame.
  expect(seen!.colors.bg).toBe(day.colors.bg);
  await tick(SKY_BLEND_MS * 0.5);
  const mid = seen!.colors.bg;
  expect(mid).not.toBe(day.colors.bg);
  expect(mid).not.toBe(night.colors.bg);
  await tick(SKY_BLEND_MS);
  expect(seen!.colors.bg).toBe(night.colors.bg);
  expect(seen!.scheme).toBe('dark');
  expect(seen!.mood).toEqual(NIGHT);
});

test('an equal mood in a new object does not re-blend; a weather change does', async () => {
  const view = await render(
    <ThemeProvider mood={DAY}>
      <Probe />
    </ThemeProvider>
  );
  await tick(2000);
  const before = seen;
  await view.rerender(
    <ThemeProvider mood={{ ...DAY, weather: { ...CLEAR } }}>
      <Probe />
    </ThemeProvider>
  );
  await tick(100);
  expect(seen!.colors).toBe(before!.colors);

  await view.rerender(
    <ThemeProvider mood={RAIN_DAY}>
      <Probe />
    </ThemeProvider>
  );
  await tick(SKY_BLEND_MS + 100);
  expect(seen!.colors.accent).toBe(skyBundle(RAIN_DAY).colors.accent);
});

test('a pinned scheme switches at once and ignores the mood', async () => {
  const view = await render(
    <ThemeProvider scheme="light" mood={NIGHT}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.scheme).toBe('light');
  expect(seen!.mood).toBeNull();
  await view.rerender(
    <ThemeProvider scheme="dark">
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.scheme).toBe('dark');
});

test('a switch from the sky to a static look lands at once, and back to the sky at once too, even after the sky had settled', async () => {
  const view = await render(
    <ThemeProvider mood={DAY}>
      <Probe />
    </ThemeProvider>
  );
  await tick(2000);
  await view.rerender(
    <ThemeProvider scheme="dark" mood={null}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.colors).toBe(plainBundle('dark').colors);
  expect(seen!.sky).toBe(plainBundle('dark').sky);
  expect(seen!.mood).toBeNull();
  await tick(2000);
  await view.rerender(
    <ThemeProvider mood={NIGHT}>
      <Probe />
    </ThemeProvider>
  );
  expect(seen!.colors.bg).toBe(skyBundle(NIGHT).colors.bg);
  expect(seen!.sky).toEqual(skyBundle(NIGHT).sky);
  expect(seen!.mood).toEqual(NIGHT);
  // Once back on the sky, a later change of sky blends again.
  await tick(2000);
  await view.rerender(
    <ThemeProvider mood={DAY}>
      <Probe />
    </ThemeProvider>
  );
  await tick(SKY_BLEND_MS * 0.5);
  expect(seen!.colors.bg).not.toBe(skyBundle(DAY).colors.bg);
  expect(seen!.colors.bg).not.toBe(skyBundle(NIGHT).colors.bg);
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
