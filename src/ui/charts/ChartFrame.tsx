import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button } from '../primitives/Button';
import { Text } from '../primitives/Text';
import { useTheme } from '../theme';
import { ChartTable, type ChartTableProps } from './ChartTable';

export type ChartToggleLabels = { table: string; chart: string };

const DEFAULT_TOGGLE: ChartToggleLabels = { table: 'Show as table', chart: 'Show as chart' };

type Props = {
  /** The data in a sentence: what a screen reader gets instead of the drawing. */
  label: string;
  /** One visible line under the chart, in the product's words; the caller writes it. */
  summaryText?: string;
  table: Omit<ChartTableProps, 'testID'>;
  toggleLabels?: ChartToggleLabels;
  children: ReactNode;
  testID?: string;
};

/**
 * What every chart shares: the drawing is one accessible image with the data as its label, a
 * real button swaps it for the table, and the summary line stays put in both views.
 */
export function ChartFrame({
  label,
  summaryText,
  table,
  toggleLabels = DEFAULT_TOGGLE,
  children,
  testID,
}: Props) {
  const t = useTheme();
  const [showTable, setShowTable] = useState(false);

  return (
    <View testID={testID} style={{ gap: t.space.sm }}>
      {showTable ? (
        <ChartTable {...table} testID={testID ? `${testID}-table` : undefined} />
      ) : (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={label}
          testID={testID ? `${testID}-chart` : undefined}
        >
          {/* The label carries the data; the drawing is hidden so a screen reader never lands on
              a stray tick numeral or value after the image itself. */}
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {children}
          </View>
        </View>
      )}
      {summaryText ? (
        <Text variant="footnote" tone="muted">
          {summaryText}
        </Text>
      ) : null}
      {/* The ghost button carries its own side padding; pulling it back keeps the label on the chart's left edge. */}
      <View style={{ alignSelf: 'flex-start', marginLeft: -t.space.lg }}>
        <Button
          label={showTable ? toggleLabels.chart : toggleLabels.table}
          variant="ghost"
          size="md"
          onPress={() => setShowTable((v) => !v)}
        />
      </View>
    </View>
  );
}
