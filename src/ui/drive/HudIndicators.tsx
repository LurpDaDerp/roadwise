import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ThermalLevel } from '@drive-sense';
import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { fontFamilies } from '../fonts';
import { hudLabelScale, hudPalette } from './hudTokens';

/** The host's GPS quality (H1's `DriveState['gps']`). */
export type HudGps = 'good' | 'weak' | 'none';

export type HudIndicatorsProps = {
  gps: HudGps;
  thermal: ThermalLevel;
  batteryLow: boolean;
  passenger: boolean;
  night: boolean;
};

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

const GPS: Record<HudGps, { icon: IconName; label: string }> = {
  good: { icon: 'crosshairs-gps', label: 'GPS good' },
  weak: { icon: 'crosshairs-question', label: 'GPS weak' },
  none: { icon: 'crosshairs-off', label: 'No GPS' },
};

const THERMAL: Partial<Record<ThermalLevel, { icon: IconName; label: string }>> = {
  serious: { icon: 'thermometer', label: 'Phone warm' },
  critical: { icon: 'thermometer-alert', label: 'Phone hot' },
};

const ICON_PT = 24;
const STAMP_PT = 12;

/**
 * The corner indicators (C3 item 5): GPS quality always, and a thermal mark, low battery and the
 * PASSENGER stamp only when they apply. Drawn marks with spoken labels and no words — lost GPS is
 * the crossed-out mark, never "Finding GPS" on the HUD (SR9: failure is silent while moving).
 * Quiet, in the muted HUD ink, yet still ≥ 7:1 on black.
 */
function HudIndicatorsView({ gps, thermal, batteryLow, passenger, night }: HudIndicatorsProps) {
  const { fontScale } = useWindowDimensions();
  const p = hudPalette(night);
  const g = GPS[gps];
  const heat = THERMAL[thermal];

  return (
    <View style={styles.row}>
      <View testID="hud-ind-gps" accessible accessibilityRole="image" accessibilityLabel={g.label}>
        <MaterialCommunityIcons
          testID="hud-ind-gps-icon"
          name={g.icon}
          size={ICON_PT}
          color={p.inkMuted}
        />
      </View>
      {heat ? (
        <View
          testID="hud-ind-thermal"
          accessible
          accessibilityRole="image"
          accessibilityLabel={heat.label}
        >
          <MaterialCommunityIcons name={heat.icon} size={ICON_PT} color={p.inkMuted} />
        </View>
      ) : null}
      {batteryLow ? (
        <View
          testID="hud-ind-battery"
          accessible
          accessibilityRole="image"
          accessibilityLabel="Battery low"
        >
          <MaterialCommunityIcons name="battery-low" size={ICON_PT} color={p.inkMuted} />
        </View>
      ) : null}
      {passenger ? (
        <View
          testID="hud-ind-passenger"
          accessible
          accessibilityRole="text"
          accessibilityLabel="Passenger"
          style={[styles.stamp, { borderColor: p.stamp }]}
        >
          <Text
            allowFontScaling={false}
            style={[
              styles.stampText,
              { color: p.stamp, fontSize: STAMP_PT * hudLabelScale(fontScale) },
            ]}
          >
            PASSENGER
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export const HudIndicators = memo(HudIndicatorsView);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  stamp: {
    borderWidth: 2,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    transform: [{ rotate: '-4deg' }],
  },
  stampText: {
    fontFamily: fontFamilies.fieldBold,
    letterSpacing: 1.5,
  },
});
