import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { LimitSample } from '@/core/engine/types';
import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { hudSpeeding, hudSpeedMph } from './hudSelectors';
import {
  type HaloLevel,
  haloColor,
  hudLabelScale,
  hudPalette,
  SPEED_NUMERAL_PT,
} from './hudTokens';

export type SpeedReadoutProps = {
  /** The snapshot's `speedMps`. Meaningless unless `speedKnown`. */
  speedMps: number;
  /** The snapshot's `speedKnown`: the CURRENT row has a valid speed. False shows "—". */
  speedKnown: boolean;
  /** The snapshot's `limit`, for the spoken "over the limit"; gated exactly as the sign gates it. */
  limit: LimitSample | null;
  /** The halo's level: the numerals take its colour, and the plain ink when calm. */
  level: HaloLevel;
  night: boolean;
  /** Numeral size in pt, so the halo can size them to its own diameter. */
  size?: number;
};

const UNIT_PT = 20;

/**
 * The speed, centre of the halo, in B612 Mono. B612 Mono is monospaced, so every figure already
 * has one advance width and the number never shifts sideways as it changes; `tabular-nums` is
 * still set so the platform fallback face (fonts not loaded) stays tabular too.
 *
 * Over the limit the numerals shift colour with the halo — amber, then soft red well over — and
 * nothing flashes (SR3). Silent to screen readers apart from its label: no live region, since
 * continuous speech is itself a distraction (C3 A11y).
 */
function SpeedReadoutView({
  speedMps,
  speedKnown,
  limit,
  level,
  night,
  size = SPEED_NUMERAL_PT,
}: SpeedReadoutProps) {
  const p = hudPalette(night);
  const { fontScale } = useWindowDimensions();
  const mph = hudSpeedMph(speedMps, speedKnown);
  const speeding = hudSpeeding(speedMps, speedKnown, limit);
  const ink = level === 'calm' ? p.ink : haloColor(p, level);

  const label =
    mph === null
      ? 'Speed unknown'
      : `Speed ${mph} miles per hour${speeding ? ', over the limit' : ''}`;

  return (
    <View testID="hud-speed" accessible accessibilityRole="text" accessibilityLabel={label}>
      <Text
        testID="hud-speed-numeral"
        allowFontScaling={false}
        numberOfLines={1}
        style={[
          styles.numeral,
          { color: ink, fontSize: size, lineHeight: Math.round(size * 1.1) },
        ]}
      >
        {mph === null ? t('common.unknown') : String(mph)}
      </Text>
      <Text
        allowFontScaling={false}
        style={[styles.unit, { color: p.inkMuted, fontSize: UNIT_PT * hudLabelScale(fontScale) }]}
      >
        mph
      </Text>
    </View>
  );
}

/**
 * The readout re-renders only when what it displays changes — whole mph, the speeding state, the
 * level, the palette, the size — not on every snapshot at 1 Hz with a fresh `limit` object and a
 * sub-mph wobble.
 */
export function speedReadoutPropsEqual(a: SpeedReadoutProps, b: SpeedReadoutProps): boolean {
  return (
    a.night === b.night &&
    a.level === b.level &&
    a.size === b.size &&
    hudSpeedMph(a.speedMps, a.speedKnown) === hudSpeedMph(b.speedMps, b.speedKnown) &&
    hudSpeeding(a.speedMps, a.speedKnown, a.limit) ===
      hudSpeeding(b.speedMps, b.speedKnown, b.limit)
  );
}

export const SpeedReadout = memo(SpeedReadoutView, speedReadoutPropsEqual);

const styles = StyleSheet.create({
  numeral: {
    fontFamily: fontFamilies.numeralsBold,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
    textAlign: 'center',
  },
  unit: {
    fontFamily: fontFamilies.field,
    letterSpacing: 1,
    textAlign: 'center',
  },
});
