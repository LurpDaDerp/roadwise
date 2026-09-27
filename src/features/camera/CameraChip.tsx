// The HUD's camera chip: what the camera beta is doing this drive, in a few words (the controller's `monitoring`
// literal, src/core/dms/README.md "Status and events"). Calm, not a control: nothing to press at speed. Shown only
// while a camera runs or has something to explain (the permission off, a fault, the dev panel holding it).
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { DmsHudStatus } from '@/core/dms';
import { tokens } from '@/ui';
import { hudLabelScale } from '@/ui/drive';
import { fontFamilies } from '@/ui/fonts';

import { chipLabel, chipTone } from './copy';
import { useCameraStatus } from './runtime';

export const CameraChip = memo(function CameraChip({ ink, inkMuted, status }: { ink: string; inkMuted: string; status?: DmsHudStatus | null }) {
  const live = useCameraStatus();
  const s = status === undefined ? live : status;
  const { fontScale } = useWindowDimensions();
  if (s === null) return null;
  const label = chipLabel(s);
  if (label === null) return null;
  const on = chipTone(s) === 'on';
  const color = on ? ink : inkMuted;
  const size = 15 * hudLabelScale(fontScale);
  return (
    <View testID="hud-camera-chip" accessible accessibilityRole="text" accessibilityLabel={label} style={styles.chip}>
      <MaterialCommunityIcons name={on ? 'eye-outline' : 'eye-off-outline'} size={20} color={color} />
      <Text allowFontScaling={false} style={[styles.words, { color, fontSize: size, lineHeight: Math.round(size * 1.25) }]}>
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens.space.sm },
  words: { fontFamily: fontFamilies.field, textAlign: 'center' },
});
