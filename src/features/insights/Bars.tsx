import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { fontFamilies, Text, useTheme } from '@/ui';
// The numeral column's width is not on the charts barrel; it is imported from the module that
// owns it so these bars reserve exactly what `ChartTable` and `CategoryBars` reserve, and the
// numbers beside a bar line up with the numbers in the table it toggles to.
import { NUMERIC_COLUMN_MIN_WIDTH } from '@/ui/charts/ChartTable';

import type { BarRow } from './format';

/** The box's corner; the fill's data end sits concentric inside the 1 dp rule, one less. */
const BOX_RADIUS = 4;
const BAR_HEIGHT = 10;

const pct = (part: number, whole: number) =>
  `${Math.max(0, Math.min(100, (part / Math.max(whole, Number.EPSILON)) * 100)).toFixed(2)}%` as `${number}%`;

/**
 * Printed field boxes, one per row: the track is the whole of what could be, the ID-blue fill is
 * what was. A row with nothing to measure leaves the box empty and prints an em dash rather than
 * a zero, because "no drives" and "nothing lost" are not the same sentence.
 *
 * The geometry — a 36 % name column, a full-width track, a right-aligned numeral column at the
 * table's own width — is `CategoryBars`' geometry, so a chart here and a chart on the trip
 * summary line up as one system. Deductions are printed in ink, never in red: the score coaches.
 */
export function Bars({
  rows,
  onPress,
  pressHint,
  testID,
}: {
  rows: readonly BarRow[];
  /** Makes every row a button. The row carries its own spoken sentence as its label. */
  onPress?: (key: string) => void;
  pressHint?: string;
  testID?: string;
}) {
  const th = useTheme();
  const id = (suffix: string) => (testID ? `${testID}-${suffix}` : undefined);

  return (
    <View style={{ gap: onPress ? 0 : th.space.sm }}>
      {rows.map((row, index) => {
        const body = (
          <>
            <Text variant="subhead" style={{ width: '36%' }}>
              {row.label}
            </Text>
            <View style={{ flex: 1 }}>
              <View
                testID={id(`track-${row.key}`)}
                style={{
                  height: BAR_HEIGHT,
                  borderRadius: BOX_RADIUS,
                  borderWidth: 1,
                  borderColor: th.colors.borderStrong,
                  backgroundColor: th.colors.surfaceRaised,
                  overflow: 'hidden',
                }}
              >
                {row.value !== null && row.value > 0 ? (
                  <View
                    testID={id(`fill-${row.key}`)}
                    style={{
                      width: pct(row.value, row.max),
                      height: '100%',
                      backgroundColor: th.colors.accent,
                      borderTopRightRadius: BOX_RADIUS - 1,
                      borderBottomRightRadius: BOX_RADIUS - 1,
                    }}
                  />
                ) : null}
              </View>
            </View>
            <Text
              variant="footnote"
              tone="muted"
              style={{
                minWidth: NUMERIC_COLUMN_MIN_WIDTH,
                textAlign: 'right',
                fontFamily: fontFamilies.numerals,
                fontVariant: ['tabular-nums'],
              }}
            >
              {row.printed}
            </Text>
          </>
        );

        if (!onPress) {
          return (
            <View
              key={row.key}
              testID={id(`row-${row.key}`)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}
            >
              {body}
            </View>
          );
        }

        return (
          <Pressable
            key={row.key}
            testID={id(`row-${row.key}`)}
            accessibilityRole="button"
            accessibilityLabel={row.spoken}
            accessibilityHint={pressHint}
            onPress={() => onPress(row.key)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: th.space.md,
              minHeight: 44,
              paddingVertical: th.space.sm,
              borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: th.colors.divider,
              backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
            })}
          >
            {body}
            <Ionicons name="chevron-forward" size={16} color={th.colors.textSubtle} />
          </Pressable>
        );
      })}
    </View>
  );
}
