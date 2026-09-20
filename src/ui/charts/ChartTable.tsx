import { StyleSheet, View } from 'react-native';

import { fontFamilies } from '../fonts';
import { Text } from '../primitives/Text';
import { useTheme } from '../theme';

export type ChartTableColumn = { title: string; numeric?: boolean };

export type ChartTableRow = {
  key: string;
  cells: readonly string[];
  /** The whole row as one sentence: what a screen reader speaks when it lands on the row. */
  label: string;
};

export type ChartTableProps = {
  /** Names the table to assistive tech; the chart it stands in for is captioned visibly. */
  caption: string;
  columns: readonly ChartTableColumn[];
  rows: readonly ChartTableRow[];
  emptyText?: string;
  testID?: string;
};

/**
 * The same numbers as the chart, printed as a ruled record. Every row is one accessible element
 * carrying its sentence, so VoiceOver and TalkBack read "Aug 4, 71, Getting there" in one swipe
 * instead of three unrelated cells. Numerals are set in the field face at a fixed advance width,
 * so the column lines up.
 */
export function ChartTable({
  caption,
  columns,
  rows,
  emptyText = 'Nothing to show yet',
  testID,
}: ChartTableProps) {
  const t = useTheme();

  const cell = (i: number) => {
    const numeric = !!columns[i]?.numeric;
    return {
      flex: numeric ? 0 : 1,
      minWidth: numeric ? 64 : undefined,
      textAlign: numeric ? ('right' as const) : ('left' as const),
    };
  };

  return (
    <View
      testID={testID}
      role="table"
      accessibilityLabel={caption}
      style={{ borderTopWidth: 1, borderTopColor: t.colors.borderStrong }}
    >
      <View
        role="row"
        accessible
        accessibilityLabel={columns.map((c) => c.title).join(', ')}
        style={{
          flexDirection: 'row',
          gap: t.space.md,
          paddingVertical: t.space.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: t.colors.borderStrong,
        }}
      >
        {columns.map((c, i) => (
          <Text
            key={c.title}
            role="columnheader"
            variant="caption"
            tone="subtle"
            style={[cell(i), { textTransform: 'uppercase', letterSpacing: 0.8 }]}
          >
            {c.title}
          </Text>
        ))}
      </View>
      {rows.length === 0 ? (
        <Text variant="footnote" tone="muted" style={{ paddingVertical: t.space.md }}>
          {emptyText}
        </Text>
      ) : (
        rows.map((r) => (
          <View
            key={r.key}
            role="row"
            accessible
            accessibilityLabel={r.label}
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              gap: t.space.md,
              paddingVertical: t.space.sm,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: t.colors.divider,
            }}
          >
            {r.cells.map((value, i) => (
              <Text
                key={i}
                role="cell"
                variant="subhead"
                style={[
                  cell(i),
                  columns[i]?.numeric
                    ? { fontFamily: fontFamilies.numerals, fontVariant: ['tabular-nums' as const] }
                    : null,
                ]}
              >
                {value}
              </Text>
            ))}
          </View>
        ))
      )}
    </View>
  );
}
