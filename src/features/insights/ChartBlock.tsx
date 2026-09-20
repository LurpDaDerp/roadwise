import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';
import { ChartTable, type ChartTableProps } from '@/ui/charts';

import { insightsCopy as copy } from './copy';

export type ChartBlockProps = {
  /** The whole drawing in one sentence, for a reader that cannot see it. */
  label: string;
  /** The visible line under the chart, in the product's words (§7.E E1 a11y: every chart has one). */
  summaryText: string;
  table: Omit<ChartTableProps, 'testID'>;
  /**
   * Off (the default) for a drawing: it becomes one accessible image whose label is `label`, and
   * the marks inside it are hidden so a reader never lands on a stray bar or numeral.
   *
   * On when the rows are controls. `@/ui/charts`' own `ChartFrame` always hides its children,
   * which is right for an SVG and wrong for a row of buttons — a hidden button cannot be reached
   * at all. With this on, the children carry their own labels and the container carries none.
   */
  interactive?: boolean;
  children: ReactNode;
  testID?: string;
};

/**
 * What every chart on the insight screens shares: the drawing, one summary sentence that stays
 * put in both views, and a real button that swaps the drawing for the same numbers as a ruled
 * table. Built to match `ChartFrame` exactly, so a chart drawn here and one drawn by
 * `@/ui/charts` read as one system.
 */
export function ChartBlock({
  label,
  summaryText,
  table,
  interactive = false,
  children,
  testID,
}: ChartBlockProps) {
  const th = useTheme();
  const [showTable, setShowTable] = useState(false);

  const drawing = interactive ? (
    <View testID={testID ? `${testID}-chart` : undefined}>{children}</View>
  ) : (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      testID={testID ? `${testID}-chart` : undefined}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {children}
      </View>
    </View>
  );

  return (
    <View testID={testID} style={{ gap: th.space.sm }}>
      {showTable ? (
        <ChartTable {...table} testID={testID ? `${testID}-table` : undefined} />
      ) : (
        drawing
      )}
      <Text variant="footnote" tone="muted">
        {summaryText}
      </Text>
      {/* The ghost button carries its own side padding; pulling it back keeps the label on the
          chart's left edge. */}
      <View style={{ alignSelf: 'flex-start', marginLeft: -th.space.lg }}>
        <Button
          label={showTable ? copy.chart.showChart : copy.chart.showTable}
          variant="ghost"
          size="md"
          onPress={() => setShowTable((open) => !open)}
        />
      </View>
    </View>
  );
}
