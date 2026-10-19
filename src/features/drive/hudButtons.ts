import type { HudPalette } from '@/ui/drive';
import type { Theme } from '@/ui/theme';

/**
 * The driving screen's buttons (End, the navigation button) in the app's own set, as Start drive
 * wears it: a paper face, ink on it, and the sky's accent, which follows the time of day and the
 * weather. At night the paper dims to the HUD's ink (no pure white on a dark road). Outside a theme
 * (no sky to follow) they keep the HUD's own colours.
 */
export type HudButtonColors = { paper: string; ink: string; accent: string };

export function hudButtonColors(theme: Theme | null, p: HudPalette, night: boolean): HudButtonColors {
  if (theme === null) return { paper: p.ink, ink: p.chrome, accent: p.haloCalm };
  const c = theme.onScene;
  return { paper: night ? p.ink : c.primary, ink: c.onPrimary, accent: c.accent };
}
