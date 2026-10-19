import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Text, useTheme } from '@/ui';

import type { Metric } from './format';

/**
 * One number with its unit in small print and a one-to-three word caption under it, read as one
 * element ("Distance, 48.2 miles"). Pass `onPress` to make it a button, and `text` to draw the
 * number, unit and caption at sizes other than the stat, footnote and label styles' own.
 */
export function MetricCell({
  caption,
  metric,
  onPress,
  hint,
  text,
  style,
  testID,
}: {
  caption: string;
  metric: Metric;
  onPress?: () => void;
  hint?: string;
  text?: { stat?: TextStyle; unit?: TextStyle; label?: TextStyle };
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const t = useTheme();
  const body = (
    <>
      <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit style={text?.stat} testID={testID ? `${testID}-value` : undefined}>
        {metric.value}
        {metric.unit ? (
          <Text variant="footnote" tone="muted" style={text?.unit}>{` ${metric.unit}`}</Text>
        ) : null}
      </Text>
      <Text variant="label" tone="muted" numberOfLines={1} adjustsFontSizeToFit style={text?.label} testID={testID ? `${testID}-caption` : undefined}>
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
