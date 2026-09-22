import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useDrive } from '@/drive/useDrive';
import { tokens } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import { HUD, hudLabelScale } from '@/ui/drive';

import { AlertsUnavailableMark, useAlertsUnavailable } from './AlertsUnavailableMark';
import { hudCopy } from './hudCopy';

/**
 * The quiet print of the drive's dark screens (the pocket screen, the parked card's second line):
 * dim next to the HUD's lit numerals, yet still 5.3:1 on black, so a word is legible to anyone who
 * does look.
 */
export const POCKET_INK = '#7F7F7F';

const TITLE_PT = 32;
const LINE_PT = 20;

/**
 * What a pocket or auto-detected drive shows when RoadWise is opened while moving (SR8: "shows
 * only the locked HUD"). There is nothing to do here: one drawn mark and three words, on true
 * black. Logging the open as phone use is the engine's (E1); this screen only refuses to be used.
 *
 * "Recording" appears only while the engine records.
 */
export function ParkedOnlyCard() {
  const recording = useDrive((s) => s.status === 'recording');
  // At speed this card is all a pocket driver can see, so a silent drive says so here too (U2 n1).
  const alertsUnavailable = useAlertsUnavailable();
  const { fontScale } = useWindowDimensions();
  const scale = hudLabelScale(fontScale);
  const ink = HUD.day.ink;

  return (
    <View
      testID="parked-only-card"
      accessible
      accessibilityRole="text"
      accessibilityLabel={
        (recording ? hudCopy.parked.labelRecording : hudCopy.parked.label) +
        (alertsUnavailable ? ` ${hudCopy.alerts.unavailable}.` : '')
      }
      style={styles.root}
    >
      <MaterialCommunityIcons name="parking" size={72} color={ink} />
      <Text
        allowFontScaling={false}
        style={[
          styles.title,
          {
            color: ink,
            fontSize: TITLE_PT * scale,
            lineHeight: Math.round(TITLE_PT * scale * 1.2),
          },
        ]}
      >
        {hudCopy.parked.title}
      </Text>
      {recording ? (
        <Text
          allowFontScaling={false}
          style={[
            styles.line,
            { fontSize: LINE_PT * scale, lineHeight: Math.round(LINE_PT * scale * 1.25) },
          ]}
        >
          {hudCopy.parked.recording}
        </Text>
      ) : null}
      {alertsUnavailable ? <AlertsUnavailableMark ink={POCKET_INK} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.space.lg,
    paddingHorizontal: tokens.space.xl,
  },
  title: { fontFamily: fontFamilies.fieldBold, textAlign: 'center' },
  line: { color: POCKET_INK, fontFamily: fontFamilies.field, textAlign: 'center' },
});
