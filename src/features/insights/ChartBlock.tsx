import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';
import { ChartTable, type ChartTableProps } from '@/ui/charts';

import { insightsCopy as copy } from './copy';

type ChartBlockBase = {
  /** The visible line under the chart, in the product's words (§7.E E1 a11y: every chart has one). */
  summaryText: string;
  table: Omit<ChartTableProps, 'testID'>;
  children: ReactNode;
  testID?: string;
};

/**
 * A drawing is one accessible image whose label is `label`, with the marks inside it hidden so a
 * reader never lands on a stray bar or numeral.
 *
 * `interactive` is for a chart whose rows are controls. `@/ui/charts`' own `ChartFrame` always
 * hides its children, which is right for an SVG and wrong for a row of buttons — a hidden button
 * cannot be reached at all. There the children carry their own labels and the container carries
 * none, so `label` is not merely optional: asking for one would be paying to build a sentence
 * nothing can read.
 */
export type ChartBlockProps = ChartBlockBase &
  ({ interactive: true; label?: never } | { interactive?: false; label: string });

/**
 * What every chart on the insight screens shares: the drawing, one summary sentence that stays
 * put in both views, and a real button that swaps the drawing for the same numbers as a ruled
 * table. Built to match `ChartFrame` exactly, so a chart drawn here and one drawn by
 * `@/ui/charts` read as one system.
 */
export function ChartBlock(props: ChartBlockProps) {
  const { summaryText, table, children, testID } = props;
  const th = useTheme();
  const [showTable, setShowTable] = useState(false);

  // Narrowed on the whole `props` object rather than on a destructured flag: destructuring breaks
  // the link between the discriminant and `label`, and the cast it then needs would be the only
  // thing standing between a caller and an unlabelled image.
  const drawing = props.interactive ? (
    <View testID={testID ? `${testID}-chart` : undefined}>{children}</View>
  ) : (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.label}
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
