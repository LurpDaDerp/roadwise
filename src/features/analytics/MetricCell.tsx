import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text, useTheme } from '@/ui';

import type { Metric } from './format';

/**
 * One number with its unit in small print and a one-to-three word caption under it, read as one
 * element ("Distance, 48.2 miles"). Pass `onPress` to make it a button.
 */
export function MetricCell({
  caption,
  metric,
  onPress,
  hint,
  style,
  testID,
}: {
  caption: string;
  metric: Metric;
  onPress?: () => void;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const t = useTheme();
  const body = (
    <>
      <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit testID={testID ? `${testID}-value` : undefined}>
        {metric.value}
        {metric.unit ? (
          <Text variant="footnote" tone="muted">{` ${metric.unit}`}</Text>
        ) : null}
      </Text>
      <Text variant="label" tone="muted" numberOfLines={1} adjustsFontSizeToFit>
        {caption}
      </Text>
    </>
  );
  const label = `${caption}, ${metric.spoken}`;
  const box: ViewStyle = { gap: METRIC_CELL_GAP, minWidth: 0 };
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        onPress={onPress}
        hitSlop={t.space.xs}
        style={({ pressed }) => [box, { opacity: pressed ? 0.6 : 1 }, style]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View testID={testID} accessible accessibilityLabel={label} style={[box, style]}>
      {body}
    </View>
  );
}

/** The space between a cell's number and its caption. */
export const METRIC_CELL_GAP = 2;
