import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useDrive } from '@/drive/useDrive';
import { tokens, useTheme } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import { hudLabelScale } from '@/ui/drive';

import { hudCopy } from './hudCopy';
import { POCKET_INK } from './ParkedOnlyCard';
import {
  mayRevealControls,
  useEndOfDriveRouting,
  useStoppedActions,
  useStoppedPanel,
} from './HudScreen';
import { StoppedPanel } from './StoppedPanel';

const LABEL_PT = 20;

/**
 * C4c, the pocket-mode in-app screen: near-black, one dim word. The phone is in a pocket or face
 * down, so nothing here asks for a look and nothing lights the screen up. The engine's C6 signal
 * does NOT raise the stopped panel on its own here — a pocket full of buttons is a pocket of
 * accidental taps — a tap while stopped brings it up instead.
 *
 * "Recording" follows the engine: it is shown only while the engine records, and the gap window
 * (the car has been still for minutes) says "Stopped" instead.
 */
export function PocketScreen() {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const s = useDrive((d) => ({
    status: d.status,
    passenger: d.role === 'passenger',
    mutedForDrive: d.mutedForDrive,
    lockedOut: d.lockedOut,
    awaitingSpeedAfterResume: d.awaitingSpeedAfterResume,
    speedKnown: d.speedKnown,
    speedMps: d.speedMps,
  }));
  useEndOfDriveRouting(true);
  const panel = useStoppedPanel(false);
  const actions = useStoppedActions();

  const word =
    s.status === 'recording'
      ? hudCopy.pocket.recording
      : s.status === 'ending'
        ? hudCopy.pocket.stopped
        : null;
  const size = LABEL_PT * hudLabelScale(fontScale);
  const text = [styles.label, { fontSize: size, lineHeight: Math.round(size * 1.25) }];

  return (
    <View testID="pocket-screen" style={styles.root}>
      <Pressable
        testID="pocket-tap-area"
        onPress={panel.reveal}
        accessibilityHint={mayRevealControls(s) ? hudCopy.pocket.hintStopped : undefined}
        style={styles.fill}
      >
        {word ? (
          <Text allowFontScaling={false} style={text}>
            {word}
          </Text>
        ) : null}
        {s.passenger ? (
          <Text allowFontScaling={false} style={text}>
            {hudCopy.pocket.passenger}
          </Text>
        ) : null}
      </Pressable>
      <StoppedPanel
        visible={panel.visible}
        passenger={s.passenger}
        mutedForDrive={s.mutedForDrive}
        night
        reduceMotion={th.reduceMotion}
        {...actions}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: tokens.space.sm },
  label: { color: POCKET_INK, fontFamily: fontFamilies.field, textAlign: 'center' },
});
