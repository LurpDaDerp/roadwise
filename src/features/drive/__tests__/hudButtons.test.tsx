import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { contrastRatio } from '@/ui/contrast';
import { HUD } from '@/ui/drive';
import { defaultMood, type SkyMood } from '@/ui/sky/palette';
import { ThemeProvider, useTheme } from '@/ui/theme';

import { hudButtonColors } from '../hudButtons';

const themeFor = async (mood: SkyMood) =>
  (await renderHook(() => useTheme(), { wrapper: ({ children }: { children: ReactNode }) => <ThemeProvider mood={mood}>{children}</ThemeProvider> })).result
    .current;

const ground = (night: boolean, g: string) => ({ ...(night ? HUD.night : HUD.day), ground: g });

describe('the driving screen buttons', () => {
  test("wear a face lifted from the HUD's sky, the app's ink at 7:1 on it, and the sky accent following the hour and the weather", async () => {
    const day = await themeFor(defaultMood('light'));
    const hud = day.sky.hud.day;
    const b = hudButtonColors(day, ground(false, hud.stops[1]), false);
    expect(b.ink).toBe(day.onScene.onPrimary);
    expect(b.accent).toBe(day.onScene.accent);
    // softer than white, clearly lighter than the screen, the ink well clear of AA
    expect(b.paper).not.toBe('#FFFFFF');
    expect(contrastRatio(b.paper, '#FFFFFF')).toBeGreaterThan(1.2);
    expect(contrastRatio(b.paper, hud.stops[1])).toBeGreaterThan(7);
    expect(contrastRatio(b.ink, b.paper)).toBeGreaterThanOrEqual(7);
    // End's fill shows on the face
    expect(contrastRatio(b.fill, b.paper)).toBeGreaterThanOrEqual(1.6 - 1e-9);
    const dusk = await themeFor({ ...defaultMood('light'), phase: 'dusk' });
    expect(hudButtonColors(dusk, ground(false, dusk.sky.hud.day.stops[1]), false).accent).not.toBe(b.accent);
    const rain = await themeFor({ ...defaultMood('light'), weather: { kind: 'rain', intensity: 'moderate' } });
    const wet = hudButtonColors(rain, ground(false, rain.sky.hud.day.stops[1]), false);
    expect(wet.accent).not.toBe(b.accent);
    // the face follows the sky too
    expect(wet.paper).not.toBe(b.paper);
  });

  test("at night the face is the sky lifted toward the HUD's dimmer ink, never brighter than it; outside a theme they keep the HUD's colours", async () => {
    const night = await themeFor(defaultMood('dark'));
    const g = night.sky.hud.night.stops[1];
    const b = hudButtonColors(night, ground(true, g), true);
    expect(contrastRatio(b.paper, '#000000')).toBeLessThanOrEqual(contrastRatio(HUD.night.ink, '#000000'));
    expect(contrastRatio(b.ink, b.paper)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(b.fill, b.paper)).toBeGreaterThanOrEqual(1.6 - 1e-9);
    expect(hudButtonColors(null, HUD.day, false)).toEqual({ paper: HUD.day.ink, ink: HUD.day.chrome, accent: HUD.day.haloCalm, fill: HUD.day.haloCalm });
  });
});
