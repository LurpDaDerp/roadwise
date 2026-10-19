import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { HUD } from '@/ui/drive';
import { defaultMood, type SkyMood } from '@/ui/sky/palette';
import { ThemeProvider, useTheme } from '@/ui/theme';

import { hudButtonColors } from '../hudButtons';

const themeFor = async (mood: SkyMood) =>
  (await renderHook(() => useTheme(), { wrapper: ({ children }: { children: ReactNode }) => <ThemeProvider mood={mood}>{children}</ThemeProvider> })).result
    .current;

describe('the driving screen buttons', () => {
  test("wear the app's paper, ink and sky accent, the accent following the hour and the weather", async () => {
    const day = await themeFor(defaultMood('light'));
    const b = hudButtonColors(day, HUD.day, false);
    expect(b).toEqual({ paper: day.onScene.primary, ink: day.onScene.onPrimary, accent: day.onScene.accent });
    const dusk = await themeFor({ ...defaultMood('light'), phase: 'dusk' });
    expect(hudButtonColors(dusk, HUD.day, false).accent).not.toBe(b.accent);
    const rain = await themeFor({ ...defaultMood('light'), weather: { kind: 'rain', intensity: 'moderate' } });
    expect(hudButtonColors(rain, HUD.day, false).accent).not.toBe(b.accent);
  });

  test("at night the paper dims to the HUD's ink; outside a theme they keep the HUD's colours", async () => {
    const night = await themeFor(defaultMood('dark'));
    expect(hudButtonColors(night, HUD.night, true).paper).toBe(HUD.night.ink);
    expect(hudButtonColors(null, HUD.day, false)).toEqual({ paper: HUD.day.ink, ink: HUD.day.chrome, accent: HUD.day.haloCalm });
  });
});
