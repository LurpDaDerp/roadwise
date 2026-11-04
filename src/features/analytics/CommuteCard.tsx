import { Fragment } from 'react';
import { View } from 'react-native';

import { Card, Divider, ListRow, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { commuteText, type CommuteRow } from './commuteModel';

const c = analyticsCopy.commute;

/** One leg: "Home → Work", its usual time and departure, and its score with how it moved. */
function LegRow({ row, onOpen }: { row: CommuteRow; onOpen: (id: CommuteRow['id']) => void }) {
  const text = commuteText(row);
  return (
    <ListRow
      title={text.title}
      subtitle={text.line}
      detail={
        text.score === null ? undefined : (
          <Text variant="footnote" tone="muted" testID={`analytics-commute-score-${row.id}`}>
            {text.score}
          </Text>
        )
      }
      accessory="chevron"
      onPress={() => onOpen(row.id)}
      accessibilityLabel={text.spoken}
      accessibilityHint={c.rowHint}
      testID={`analytics-commute-${row.id}`}
    />
  );
}

/**
 * "Your commute": one row per commute leg with enough drives in the last 4 months (Home → Work,
 * Work → Home, Home → School, School → Home), each opening its sheet. Hidden when no leg has enough.
 */
export function CommuteCard({ rows, onOpen }: { rows: readonly CommuteRow[]; onOpen: (id: CommuteRow['id']) => void }) {
  const t = useTheme();
  if (rows.length === 0) return null;
  return (
    <Card padded={false} testID="analytics-commute">
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg, paddingBottom: t.space.xs, gap: t.space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: t.space.md }}>
          <Text variant="title3" accessibilityRole="header">
            {c.title}
          </Text>
          <Text variant="footnote" tone="subtle">
            {c.caption}
          </Text>
        </View>
      </View>
      {rows.map((row, i) => (
        <Fragment key={row.id}>
          {i > 0 ? <Divider inset={t.space.lg} /> : null}
          <LegRow row={row} onOpen={onOpen} />
        </Fragment>
      ))}
    </Card>
  );
}
