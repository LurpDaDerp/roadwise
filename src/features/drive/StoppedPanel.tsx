import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tokens } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import { HUD_MIN_TARGET_PT, hudLabelScale, hudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

/**
 * C6: a tap on the stopped panel acts this long after it lands, and not at all if the panel hid
 * meanwhile — "taps in the last 300 ms before hiding are discarded to prevent accidental actions".
 */
export const STOPPED_ACTION_DELAY_MS = 300;

export type StoppedPanelProps = {
  visible: boolean;
  passenger: boolean;
  mutedForDrive: boolean;
  night: boolean;
  reduceMotion: boolean;
  onEnd: () => void;
  onMuteForDrive: () => void;
  onSetPassenger: (passenger: boolean) => void;
};

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

const LABEL_PT = 22;
const ICON_PT = 28;

/**
 * C6, the stopped panel: the few legitimate actions, offered only while the car is stationary and
 * removed the moment it moves. It slides up over the HUD (or the pocket screen) from the bottom,
 * End drive first and largest, then the drive mute and the driver swap; every target is ≥ 64 pt.
 * There are no links into the rest of the app.
 *
 * Every action is deferred by `STOPPED_ACTION_DELAY_MS` and cancelled if the panel hides first, so
 * a tap that lands just as the car rolls off does nothing. One action at a time: a second tap while
 * one is pending is ignored.
 */
export const StoppedPanel = memo(function StoppedPanel({
  visible,
  passenger,
  mutedForDrive,
  night,
  reduceMotion,
  onEnd,
  onMuteForDrive,
  onSetPassenger,
}: StoppedPanelProps) {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slide] = useState(() => new Animated.Value(reduceMotion ? 0 : 1));
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const p = hudPalette(night);

  // Hiding (or unmounting) drops a tap that has not yet acted.
  useEffect(() => {
    if (visible) return;
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  }, [visible]);
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    []
  );

  useEffect(() => {
    if (!visible) return;
    AccessibilityInfo.announceForAccessibility(hudCopy.stopped.announcement);
    if (reduceMotion) {
      slide.setValue(0);
      return;
    }
    slide.setValue(1);
    Animated.timing(slide, {
      toValue: 0,
      duration: tokens.motion.base,
      easing: Easing.out(Easing.exp),
      useNativeDriver: true,
    }).start();
  }, [visible, reduceMotion, slide]);

  const defer = useCallback((action: () => void) => {
    if (pending.current !== null) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      action();
    }, STOPPED_ACTION_DELAY_MS);
  }, []);

  if (!visible) return null;

  const scale = hudLabelScale(fontScale);

  return (
    <Animated.View
      testID="stopped-panel"
      accessibilityLabel={hudCopy.stopped.panelLabel}
      style={[
        styles.panel,
        {
          backgroundColor: p.ground,
          borderTopColor: p.inkMuted,
          paddingBottom: Math.max(insets.bottom, tokens.space.lg),
          paddingLeft: Math.max(insets.left, tokens.space.lg),
          paddingRight: Math.max(insets.right, tokens.space.lg),
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 400] }) },
          ],
        },
      ]}
    >
      <PanelButton
        label={hudCopy.stopped.endDrive}
        icon="flag-checkered"
        primary
        night={night}
        scale={scale}
        onPress={() => defer(onEnd)}
      />
      <View style={styles.row}>
        <PanelButton
          label={mutedForDrive ? hudCopy.stopped.mutedDrive : hudCopy.stopped.muteDrive}
          icon={mutedForDrive ? 'volume-off' : 'volume-mute'}
          disabled={mutedForDrive}
          night={night}
          scale={scale}
          onPress={() => defer(onMuteForDrive)}
        />
        <PanelButton
          label={passenger ? hudCopy.stopped.drivingNow : hudCopy.stopped.passengerNow}
          icon={passenger ? 'steering' : 'seat-passenger'}
          night={night}
          scale={scale}
          onPress={() => defer(() => onSetPassenger(!passenger))}
        />
      </View>
    </Animated.View>
  );
});

function PanelButton({
  label,
  icon,
  primary,
  disabled,
  night,
  scale,
  onPress,
}: {
  label: string;
  icon: IconName;
  primary?: boolean;
  disabled?: boolean;
  night: boolean;
  scale: number;
  onPress: () => void;
}) {
  const p = hudPalette(night);
  // Primary: the HUD ink as a solid face with black print (≥ 7:1 both ways). Secondary: outlined
  // in the muted ink, print in the full ink. Disabled keeps its print legible and drops the frame.
  const face = primary ? p.ink : p.ground;
  const print = primary ? p.ground : disabled ? p.inkMuted : p.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.primary : styles.secondary,
        {
          minHeight: primary ? HUD_MIN_TARGET_PT + 16 : HUD_MIN_TARGET_PT,
          backgroundColor: face,
          borderColor: disabled ? p.ground : primary ? p.ink : p.inkMuted,
        },
      ]}
    >
      <MaterialCommunityIcons name={icon} size={ICON_PT} color={print} />
      <Text
        allowFontScaling={false}
        style={[
          styles.label,
          {
            color: print,
            fontSize: LABEL_PT * scale,
            lineHeight: Math.round(LABEL_PT * scale * 1.2),
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    paddingTop: tokens.space.lg,
    gap: tokens.space.md,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.md },
  button: {
    flexGrow: 1,
    flexBasis: 240,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.space.md,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.md,
    borderRadius: tokens.radius.md,
  },
  primary: { borderWidth: 0 },
  secondary: { borderWidth: 2 },
  label: { fontFamily: fontFamilies.fieldBold, flexShrink: 1, textAlign: 'center' },
});
