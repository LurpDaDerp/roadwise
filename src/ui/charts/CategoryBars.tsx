import { View } from 'react-native';

import { fontFamilies } from '../fonts';
import { Text } from '../primitives/Text';
import { useTheme } from '../theme';
import { ChartFrame, type ChartToggleLabels } from './ChartFrame';
import { clamp, describeBars, formatPoints } from './format';

/** `categoryCaps` from the scoring explainer fits this as it is. */
export type CategoryCapLike = { category: string; label: string; cap: number };

export type CategoryBarsProps = {
  /** Points lost per category, keyed as `caps` is; a category that is missing lost nothing. */
  deductions: Readonly<Partial<Record<string, number>>>;
  /** Order, names and ceilings, largest cap first. */
  caps: readonly CategoryCapLike[];
  summaryText?: string;
  toggleLabels?: ChartToggleLabels;
  testID?: string;
};

const BAR_HEIGHT = 10;
const pct = (part: number, whole: number) =>
  `${((part / Math.max(whole, 1)) * 100).toFixed(2)}%` as `${number}%`;

/**
 * Points lost per category as printed field boxes. The box is as long as the category's cap and
 * the ID-blue fill is what the trip actually cost, so a long, empty box is a habit that could
 * have cost a lot and did not. Deductions are printed in ink, never in red: the score coaches,
 * it does not punish. No motion — the ring is this screen's one moving thing.
 */
export function CategoryBars({
  deductions,
  caps,
  summaryText,
  toggleLabels,
  testID,
}: CategoryBarsProps) {
  const t = useTheme();
  const id = (suffix: string) => (testID ? `${testID}-${suffix}` : undefined);
  const maxCap = Math.max(1, ...caps.map((c) => c.cap));
  const rows = caps.map((c) => ({
    key: c.category,
    label: c.label,
    cap: c.cap,
    value: clamp(deductions[c.category] ?? 0, 0, c.cap),
  }));

  const table = {
    caption: 'Points lost by category',
    columns: [{ title: 'Category' }, { title: 'Lost', numeric: true }, { title: 'Cap', numeric: true }],
    rows: rows.map((r) => ({
      key: r.key,
      cells: [r.label, formatPoints(r.value), formatPoints(r.cap)],
      label: `${r.label}, ${formatPoints(r.value)} of ${formatPoints(r.cap)} points`,
    })),
    emptyText: 'No categories',
  };

  return (
    <ChartFrame
      label={describeBars(rows)}
      summaryText={summaryText}
      table={table}
      toggleLabels={toggleLabels}
      testID={testID}
    >
      <View style={{ gap: t.space.sm }}>
        {rows.map((r) => (
          <View
            key={r.key}
            testID={id(`row-${r.key}`)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}
          >
            <Text variant="subhead" style={{ width: '36%' }}>
              {r.label}
            </Text>
            <View style={{ flex: 1 }}>
              <View
                testID={id(`track-${r.key}`)}
                style={{
                  width: pct(r.cap, maxCap),
                  height: BAR_HEIGHT,
                  borderRadius: 2,
                  borderWidth: 1,
                  borderColor: t.colors.borderStrong,
                  backgroundColor: t.colors.surfaceRaised,
                  overflow: 'hidden',
                }}
              >
                {r.value > 0 ? (
                  <View
                    testID={id(`fill-${r.key}`)}
                    style={{
                      width: pct(r.value, r.cap),
                      height: '100%',
                      backgroundColor: t.colors.accent,
                      borderTopRightRadius: 4,
                      borderBottomRightRadius: 4,
                    }}
                  />
                ) : null}
              </View>
            </View>
            <Text
              variant="footnote"
              tone="muted"
              style={{
                minWidth: 64,
                textAlign: 'right',
                fontFamily: fontFamilies.numerals,
                fontVariant: ['tabular-nums'],
              }}
            >
              {`${formatPoints(r.value)} of ${formatPoints(r.cap)}`}
            </Text>
          </View>
        ))}
      </View>
    </ChartFrame>
  );
}
