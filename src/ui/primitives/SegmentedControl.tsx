import { useEffect, useState } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

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
 * Two to four equal segments on a raised track; the selected one sits on a sliding surface thumb
 * (snappy spring; jumps under reduce motion). Each segment is a tab for VoiceOver.
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
  const x = useSharedValue(index * segW);

  useEffect(() => {
    const target = index * segW;
    x.value = t.reduceMotion ? target : withSpring(target, t.motion.spring.snappy);
  }, [index, segW, t.reduceMotion, t.motion.spring.snappy, x]);

  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

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
          minHeight: 44,
        },
        style,
      ]}
    >
      {segW > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: pad,
              bottom: pad,
              left: pad,
              width: segW,
              borderRadius: t.radius.pill,
              backgroundColor: t.scheme === 'dark' ? t.colors.primary : t.colors.surface,
              boxShadow: t.elevation.card,
            },
            thumb,
          ]}
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
                color: selected
                  ? t.scheme === 'dark'
                    ? t.colors.onPrimary
                    : t.colors.text
                  : t.colors.textMuted,
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
