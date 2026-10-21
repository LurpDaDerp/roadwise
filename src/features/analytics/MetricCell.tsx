import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Text, useTheme } from '@/ui';

import type { Metric } from './format';

/**
 * One number with its unit in small print and a one-to-three word caption under it, read as one
 * element ("Distance, 48.2 miles"). Pass `onPress` to make it a button, and `text` to draw the
 * number, unit and caption at sizes other than the stat, footnote and label styles' own.
 *
 * In a narrow cell the caption wraps (up to `captionLines`) before it shrinks, and neither the
 * number nor the caption shrinks past a floor, so large text never draws smaller than 1×.
 */
export function MetricCell({
  caption,
  spokenCaption,
  metric,
  onPress,
  hint,
  text,
  captionLines = 2,
  style,
  testID,
}: {
  caption: string;
  /** The caption in words for a screen reader, when the printed one is shorthand ("Avg points/drive"). */
  spokenCaption?: string;
  metric: Metric;
  onPress?: () => void;
  hint?: string;
  text?: { stat?: TextStyle; unit?: TextStyle; label?: TextStyle };
  /** How many lines the caption may wrap to before it shrinks (default 2). */
  captionLines?: 1 | 2;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const t = useTheme();
  const body = (
    <>
      <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={VALUE_MIN_SCALE} style={text?.stat} testID={testID ? `${testID}-value` : undefined}>
        {metric.value}
        {metric.unit ? (
          <Text variant="footnote" tone="muted" style={text?.unit}>{` ${metric.unit}`}</Text>
        ) : null}
      </Text>
      <Text
        variant="label"
        tone="muted"
        numberOfLines={captionLines}
        adjustsFontSizeToFit
        minimumFontScale={CAPTION_MIN_SCALE}
        style={text?.label} testID={testID ? `${testID}-caption` : undefined}>
        {caption}
      </Text>
    </>
  );
  const label = `${spokenCaption ?? caption}, ${metric.spoken}`;
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
/** How far a number or a caption may shrink to fit its cell, at most. */
export const VALUE_MIN_SCALE = 0.7;
export const CAPTION_MIN_SCALE = 0.85;
