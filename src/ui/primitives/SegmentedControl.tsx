import { useState } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { useTheme } from '../theme';
import { Text } from './Text';

export type Segment<V extends string> = { value: V; label: string };

export type SegmentedControlProps<V extends string> = {
  segments: readonly Segment<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Names the group for VoiceOver, e.g. "Leaderboard". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Two to four equal segments on a raised track; the selected one sits on a sliding ink thumb
 * (snappy spring; jumps under reduce motion). Each segment is a tab for VoiceOver.
 *
 * The thumb's place is plain layout, under the selected segment from the render that selects it;
 * the spring is a layout transition between the old place and the new. So the selected label (ink
 * on ink's opposite) always has the thumb under it: a transition that fails to run lands the thumb
 * at once instead of leaving it behind the old segment.
 */
export function SegmentedControl<V extends string>({
  segments,
  value,
  onChange,
  accessibilityLabel,
  style,
  testID,
}: SegmentedControlProps<V>) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    segments.findIndex((s) => s.value === value)
  );
  const pad = 3;
  const segW = width > 0 ? (width - pad * 2) / segments.length : 0;
  const spring = t.motion.spring.snappy;
  const slide = t.reduceMotion ? undefined : LinearTransition.springify().damping(spring.damping).stiffness(spring.stiffness).mass(spring.mass);

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[
        {
          flexDirection: 'row',
          padding: pad,
          borderRadius: t.radius.pill,
          backgroundColor: t.colors.surfaceRaised,
          minHeight: 48,
        },
        style,
      ]}
    >
      {segW > 0 ? (
        <Animated.View
          pointerEvents="none"
          layout={slide}
          testID={testID ? `${testID}-thumb` : undefined}
          style={{
            position: 'absolute',
            top: pad,
            bottom: pad,
            left: pad + index * segW,
            width: segW,
            borderRadius: t.radius.pill,
            backgroundColor: t.colors.primary,
            boxShadow: t.elevation.card,
          }}
        />
      ) : null}
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <Pressable
            key={s.value}
            accessibilityRole="tab"
            accessibilityLabel={s.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(s.value)}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: t.space.sm,
              paddingVertical: t.space.sm,
            }}
          >
            <Text
              variant="subhead"
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{
                fontWeight: selected ? '700' : '500',
                color: selected ? t.colors.onPrimary : t.colors.textMuted,
              }}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
