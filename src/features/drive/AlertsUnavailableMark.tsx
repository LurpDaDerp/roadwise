import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useDrive } from '@/drive/useDrive';
import { tokens } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import { hudLabelScale } from '@/ui/drive';

import { hudCopy } from './hudCopy';

/** Only an explicit false means the alert audio failed; absent (older hosts) counts as available. */
export const useAlertsUnavailable = (): boolean => useDrive((s) => s.alertsAvailable === false);

/**
 * "Sound alerts unavailable" (ruling H2 item 6): the alert audio failed to load, the drive still
 * records, and the driver must not believe they would hear a warning. A drawn mark and three words
 * in the quiet indicator ink — calm, no colour alarm, no motion — and not a control: nothing to
 * press at speed. `ink` lets the pocket screen and the parked card draw it in their own dim print.
 * Its own module, so the light screens (the parked card) need not load the HUD's.
 */
export const AlertsUnavailableMark = memo(function AlertsUnavailableMark({ ink }: { ink: string }) {
  const { fontScale } = useWindowDimensions();
  const size = 15 * hudLabelScale(fontScale);
  return (
    <View
      testID="hud-alerts-unavailable"
      accessible
      accessibilityRole="text"
      accessibilityLabel={hudCopy.alerts.label}
      style={styles.alertsMark}
    >
      <MaterialCommunityIcons name="volume-off" size={22} color={ink} />
      <Text
        allowFontScaling={false}
        style={[
          styles.alertsWords,
          { color: ink, fontSize: size, lineHeight: Math.round(size * 1.25) },
        ]}
      >
        {hudCopy.alerts.unavailable}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  alertsMark: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.space.sm,
  },
  alertsWords: { fontFamily: fontFamilies.field, textAlign: 'center' },
});
