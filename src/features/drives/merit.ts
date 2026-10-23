/**
 * A drive's merit tier in colour (M1-M4): a rarity-style ramp in the app's own palette, grey, green,
 * blue, purple, gold, from tier 1 to 5. Tiers have no names anywhere; the colour always comes with
 * the tier's icon (`MeritIcon`) or with the score it tints, never alone. Pure (no React).
 */
import type { MeritTier } from '@scoring';

import { ensureContrast, withAlpha } from '@/ui';
import { mix, opaque } from '@/ui/sky/color';
import { tokens } from '@/ui/tokens';

/** The minimum contrast of a merit ink on what it sits on: the AA floor for text. */
export const MERIT_MIN_CONTRAST = 4.5;

/** The ramp's base inks, tier 1 to 5, before the per-surface repair. */
export const MERIT_BASE: Readonly<Record<MeritTier, string>> = {
  1: '#9AA3B2',
  2: tokens.color.dark.signal.clean.text,
  3: '#4F8FE6',
  4: '#9B6DFF',
  5: tokens.color.dark.gold,
};

/** The share card's two ground stops: the tier base pulled this far toward a near-black (top-left, then bottom-right). */
const CARD_STOP_MIX = [
  { toward: '#0B0E16', amount: 0.62 },
  { toward: '#05070B', amount: 0.8 },
] as const;

/** The wash's strength behind the recap hero (≤ 12 % of the base): a touch more on the dark card. */
export const MERIT_WASH_ALPHA: Readonly<Record<'light' | 'dark', number>> = { light: 0.1, dark: 0.12 };

/**
 * The tier's ink, darkened or lightened only as far as it takes to read at 4.5:1 on every surface
 * it may sit on (the share card's sky stops, the recap card and its wash, a history row).
 */
export function meritInk(tier: MeritTier, surfaces: readonly string[]): string {
  const on = surfaces.map(opaque);
  return ensureContrast(MERIT_BASE[tier], on.length > 0 ? on : ['#FFFFFF'], MERIT_MIN_CONTRAST);
}

/** The soft tint behind the recap hero: the tier's base at 10 % on paper, 12 % on the dark card. */
export function meritWash(tier: MeritTier, scheme: 'light' | 'dark'): string {
  return withAlpha(MERIT_BASE[tier], MERIT_WASH_ALPHA[scheme]);
}

/**
 * The share card's background for a tier: a two-stop gradient, the tier's base ink (the merit tag's
 * hue) pulled 62 % toward a near-black for the top-left and 80 % for the bottom-right. Deep and
 * clearly that tier's hue (grey only for tier 1), with white at 7:1 or better on both stops, the
 * tier's own ink repaired to 4.5:1 and the gold route at 3:1 or better.
 */
export function meritCardStops(tier: MeritTier): readonly [string, string] {
  const base = MERIT_BASE[tier];
  return [mix(base, CARD_STOP_MIX[0].toward, CARD_STOP_MIX[0].amount), mix(base, CARD_STOP_MIX[1].toward, CARD_STOP_MIX[1].amount)];
}
