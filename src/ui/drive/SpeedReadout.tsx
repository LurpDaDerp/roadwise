import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { LimitSample } from '@/core/engine/types';
import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { hudSpeedMph, hudSpeeding } from './hudSelectors';
import { hudLabelScale, hudPalette, SPEED_NUMERAL_PT } from './hudTokens';

export type SpeedReadoutProps = {
  /** The snapshot's `speedMps`. Meaningless unless `speedKnown`. */
  speedMps: number;
  /** The snapshot's `speedKnown`: the CURRENT row has a valid speed. False shows "—". */
  speedKnown: boolean;
  /** The snapshot's `limit`, for the speeding state; gated exactly as the sign gates it. */
  limit: LimitSample | null;
  night: boolean;
};

/** Border and padding always sum to this, so the frame never changes size between states. */
const FRAME = 10;
const CALM_BORDER = 0;
const SPEEDING_BORDER = 10;
const UNIT_PT = 20;
const ICON_PT = 32;

/**
 * Zone 1 of the HUD (C3): the speed, centre, in B612 Mono. B612 Mono is monospaced, so every
 * figure already has one advance width and the number never shifts sideways as it changes;
 * `tabular-nums` is still set so the platform fallback face (fonts not loaded) stays tabular too.
 *
 * Speeding past tolerance changes three things at once — numeral colour, a thick border and a
 * speedometer mark — so it reads without colour vision. Silent to screen readers apart from its
 * label: no live region, since continuous speech is itself a distraction (C3 A11y).
 */
function SpeedReadoutView({ speedMps, speedKnown, limit, night }: SpeedReadoutProps) {
  const p = hudPalette(night);
  const { fontScale } = useWindowDimensions();
  const mph = hudSpeedMph(speedMps, speedKnown);
  const speeding = hudSpeeding(speedMps, speedKnown, limit);
  const border = speeding ? SPEEDING_BORDER : CALM_BORDER;
  const ink = speeding ? p.speeding : p.ink;

  const label =
    mph === null
      ? 'Speed unknown'
      : `Speed ${mph} miles per hour${speeding ? ', over the limit' : ''}`;

  return (
    <View
      testID="hud-speed"
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        styles.frame,
        {
          borderWidth: border,
          padding: FRAME - border,
          borderColor: speeding ? p.speeding : p.ground,
        },
      ]}
    >
      <Text
        testID="hud-speed-numeral"
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.numeral, { color: ink }]}
      >
        {mph === null ? t('common.unknown') : String(mph)}
      </Text>
      {/* The mark sits beside the unit, not the numerals, so the speed never moves sideways. */}
      <View style={styles.row}>
        {speeding ? (
          <MaterialCommunityIcons
            testID="hud-speeding-icon"
            name="speedometer"
            size={ICON_PT}
            color={p.speeding}
            style={styles.icon}
          />
        ) : null}
        <Text
          allowFontScaling={false}
          style={[
            styles.unit,
            {
              color: speeding ? p.speeding : p.inkMuted,
              fontSize: UNIT_PT * hudLabelScale(fontScale),
            },
          ]}
        >
          mph
        </Text>
      </View>
    </View>
  );
}

/**
 * The readout re-renders only when what it displays changes — whole mph, the speeding state, the
 * palette — not on every snapshot at 1 Hz with a fresh `limit` object and a sub-mph wobble.
 */
export function speedReadoutPropsEqual(a: SpeedReadoutProps, b: SpeedReadoutProps): boolean {
  return (
    a.night === b.night &&
    hudSpeedMph(a.speedMps, a.speedKnown) === hudSpeedMph(b.speedMps, b.speedKnown) &&
    hudSpeeding(a.speedMps, a.speedKnown, a.limit) ===
      hudSpeeding(b.speedMps, b.speedKnown, b.limit)
  );
}

export const SpeedReadout = memo(SpeedReadoutView, speedReadoutPropsEqual);

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    borderRadius: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: 6,
  },
  numeral: {
    fontFamily: fontFamilies.numeralsBold,
    fontSize: SPEED_NUMERAL_PT,
    lineHeight: Math.round(SPEED_NUMERAL_PT * 1.1),
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
  unit: {
    fontFamily: fontFamilies.field,
    letterSpacing: 1,
  },
});
