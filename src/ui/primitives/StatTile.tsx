import { Ionicons } from '@expo/vector-icons';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import type { Signal, StatHealth } from '../tokens';
import type { IconName } from './Button';
import { Text } from './Text';
import { describeTrend, TrendArrow, type TrendDirection } from './TrendArrow';

export const HEALTH_SIGNAL: Record<StatHealth, Signal> = { green: 'clean', yellow: 'minor', red: 'severe' };
/** Spoken (and printable) words for each band, so the colour is never the only signal. */
export const HEALTH_LABEL: Record<StatHealth, string> = { green: 'Good', yellow: 'Okay', red: 'Needs work' };
const HEALTH_GLYPH: Record<StatHealth, IconName> = { green: 'checkmark', yellow: 'remove', red: 'alert' };

export type StatTileProps = {
  /** "Speeding", "Harsh driving", "Clean drives". */
  label: string;
  /** Pre-formatted: "3", "92", "—". */
  value: string;
  /** "%", "mi"; none for a count. */
  unit?: string;
  /** `statColor()` from @scoring: green / yellow / red. Omit (or null) for uncoloured totals. */
  health?: StatHealth | null;
  /** vs. your own 30-day average. Omit when there is no comparison. */
  trend?: TrendDirection;
  /** Default false: for event counts, down is better. Pass true for clean-drive %. */
  higherIsBetter?: boolean;
  /** Spoken after the trend, e.g. "vs your 30-day average". */
  trendContext?: string;
  onPress?: () => void;
  /** Draws its own raised background. Off when the tile sits in a Card grid (no nested cards). */
  framed?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * One stat: a health dot (colour plus a glyph), a condensed caps label, a big tabular number with
 * its unit, and a trend arrow. Reads as one VoiceOver element.
 */
export function StatTile({
  label,
  value,
  unit,
  health,
  trend,
  higherIsBetter = false,
  trendContext = 'vs your 30-day average',
  onPress,
  framed = false,
  style,
  testID,
}: StatTileProps) {
  const t = useTheme();
  const better = higherIsBetter ? 'up' : 'down';
  const sig = health ? t.colors.signal[HEALTH_SIGNAL[health]] : null;
  const spoken = [
    label,
    unit ? `${value} ${unit}` : value,
    health ? HEALTH_LABEL[health] : null,
    trend ? `${describeTrend(trend, better)} ${trendContext}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const body = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs + 2 }}>
        {health && sig ? (
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: sig.fill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name={HEALTH_GLYPH[health]} size={11} color={sig.onFill} />
          </View>
        ) : null}
        <Text variant="label" tone="muted" numberOfLines={2} style={{ flexShrink: 1 }}>
          {label}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.space.sm, flexWrap: 'wrap' }}>
        <Text variant="stat" style={sig ? { color: sig.text } : undefined}>
          {value}
          {unit ? (
            <Text variant="footnote" tone="muted">{` ${unit}`}</Text>
          ) : null}
        </Text>
        {trend ? (
          <View style={{ paddingBottom: 6 }}>
            <TrendArrow direction={trend} better={better} size={18} accessible={false} />
          </View>
        ) : null}
      </View>
    </>
  );

  const box: ViewStyle = {
    gap: t.space.xs,
    padding: framed ? t.space.md : 0,
    borderRadius: framed ? t.radius.lg : 0,
    backgroundColor: framed ? t.colors.surfaceRaised : 'transparent',
  };

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        onPress={onPress}
        style={({ pressed }) => [box, { opacity: pressed ? 0.7 : 1 }, style]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View testID={testID} accessible accessibilityLabel={spoken} style={[box, style]}>
      {body}
    </View>
  );
}
