import { opaque } from './color';
import type { SkyBundle } from './palette';

/**
 * What the background driving display (Live Activity, Android notification) takes of the theme:
 * the driving screen's sky for the bundle's scheme, top to bottom, and the sky accent that reads on
 * dark, each as opaque "#RRGGBB" (the only form the native sides parse).
 */
export type SkyLook = { skyTop: string; skyMid: string; skyLow: string; accent: string };

export function lookFor(bundle: SkyBundle): SkyLook {
  const hud = bundle.scheme === 'dark' ? bundle.sky.hud.night : bundle.sky.hud.day;
  const [top, mid, low] = hud.stops;
  return { skyTop: opaque(top), skyMid: opaque(mid), skyLow: opaque(low), accent: opaque(bundle.onScene.accent) };
}
