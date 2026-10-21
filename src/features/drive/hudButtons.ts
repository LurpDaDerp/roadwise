import type { HudPalette } from '@/ui/drive';
import { ensureContrast, ensureGround, mix } from '@/ui';
import type { Theme } from '@/ui/theme';

/**
 * The driving screen's buttons (End, the navigation button) in the app's own set, as Start drive
 * wears it, toned to the road: the face is the HUD's sky lifted most of the way to white by day
 * (to the HUD's soft ink at night), so it shifts with the time of day and the weather and stays
 * clearly lighter than the screen without glaring; the app's ink on it at 7:1 or better, and the
 * sky's accent (End's swipe fill takes it deep enough to show on the face at 1.6:1 or more).
 * Outside a theme (no sky to follow) they keep the HUD's own colours.
 */
export type HudButtonColors = { paper: string; ink: string; accent: string; fill: string };

/** How far the face is lifted from the HUD's sky toward white (day) or the HUD's ink (night). */
export const HUD_BUTTON_LIFT = { day: 0.8, night: 0.7 } as const;
/** End's swipe fill against the face. */
export const HUD_FILL_MIN = 1.6;

export function hudButtonColors(theme: Theme | null, p: HudPalette, night: boolean): HudButtonColors {
  if (theme === null) return { paper: p.ink, ink: p.chrome, accent: p.haloCalm, fill: p.haloCalm };
  const c = theme.onScene;
  const face = night ? mix(p.ground, p.ink, HUD_BUTTON_LIFT.night) : mix(p.ground, '#FFFFFF', HUD_BUTTON_LIFT.day);
  const paper = ensureGround(face, [c.onPrimary], 7, '#FFFFFF');
  return { paper, ink: c.onPrimary, accent: c.accent, fill: ensureContrast(c.accent, [paper], HUD_FILL_MIN) };
}
