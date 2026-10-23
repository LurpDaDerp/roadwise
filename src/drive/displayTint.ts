// The speed's colour on the iOS Live Activity (modes plan §3.10): the driving screen's own numeral
// tint, so the lock screen and the halo are one curve. Nothing pulses there; only the colour moves.
import { numeralRamp, rampColor, speedingTint } from '@/ui/drive/halo';
import { hudPalette } from '@/ui/drive/hudTokens';

/**
 * `#RRGGBB` for the speed numeral at `speedingRatio` (the speed shown over the limit the sign
 * shows): the HUD halo's numeral ramp at its tint (`speedingTint`: 0 at the limit, full red at
 * 1.7 ×), in the day or night palette. Null (plain white) at or under the limit and with no ratio.
 */
export function speedTintOf(ratio: number | null, night: boolean): string | null {
  const s = speedingTint(ratio);
  return s > 0 ? rampColor(numeralRamp(hudPalette(night)), s) : null;
}
