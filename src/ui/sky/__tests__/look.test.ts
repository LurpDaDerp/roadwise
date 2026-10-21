import { lookFor } from '@/ui/sky/look';
import { plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';

const HEX = /^#[0-9A-F]{6}$/;
const mood = (phase: SkyMood['phase'], kind: SkyMood['weather']['kind'] = 'clear'): SkyMood => ({
  phase,
  glow: 0,
  weather: { kind, intensity: 'moderate' },
});

test("a light scheme gives the driving screen's day sky and the scene accent", () => {
  const b = skyBundle(mood('day'));
  expect(b.scheme).toBe('light');
  const [top, mid, low] = b.sky.hud.day.stops;
  expect(lookFor(b)).toEqual({ skyTop: top, skyMid: mid, skyLow: low, accent: b.onScene.accent });
});

test("a dark scheme gives the driving screen's night sky", () => {
  const b = skyBundle(mood('night', 'rain'));
  expect(b.scheme).toBe('dark');
  const [top, mid, low] = b.sky.hud.night.stops;
  expect(lookFor(b)).toEqual({ skyTop: top, skyMid: mid, skyLow: low, accent: b.onScene.accent });
});

test('every look is opaque "#RRGGBB", the one form the native sides parse', () => {
  for (const phase of ['day', 'dawn', 'dusk', 'night'] as const) {
    for (const kind of ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'] as const) {
      for (const v of Object.values(lookFor(skyBundle(mood(phase, kind))))) expect(v).toMatch(HEX);
    }
  }
});

test("the static looks give the driving screen's day sky for Light and its night sky for Dark, opaque hex", () => {
  const light = plainBundle('light');
  const [lt, lm, ll] = light.sky.hud.day.stops;
  expect(lookFor(light)).toEqual({ skyTop: lt, skyMid: lm, skyLow: ll, accent: light.onScene.accent });
  const dark = plainBundle('dark');
  const [dt, dm, dl] = dark.sky.hud.night.stops;
  expect(lookFor(dark)).toEqual({ skyTop: dt, skyMid: dm, skyLow: dl, accent: dark.onScene.accent });
  for (const v of [...Object.values(lookFor(light)), ...Object.values(lookFor(dark))]) expect(v).toMatch(HEX);
});
