import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Text, useTheme } from '@/ui';
import { formatPoints } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import type { Highlight } from './format';

/**
 * The three highlights (§7.D D1) as a ruled list: a drawn check beside what went well, a drawn
 * minus beside the one category that cost points, and the points lost printed as a numeral.
 * Each row is one element to a screen reader, so the list reads in three swipes.
 */
export function TripHighlights({ highlights }: { highlights: readonly Highlight[] }) {
  const th = useTheme();
  return (
    <Field label={copy.highlights.label} testID="highlights">
      <View accessibilityRole="list">
        {highlights.map((row, index) => {
          const lost = row.kind === 'cost' ? formatPoints(row.points) : null;
          return (
            <View
              key={row.category}
              accessible
              accessibilityRole="text"
              accessibilityLabel={
                lost === null ? row.text : `${row.text}, ${copy.highlights.lost(lost)}`
              }
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: th.space.md,
                minHeight: 44,
                paddingVertical: th.space.sm,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: th.colors.divider,
              }}
            >
              <Ionicons
                name={row.kind === 'positive' ? 'checkmark-circle-outline' : 'remove-circle-outline'}
                size={22}
                color={row.kind === 'positive' ? th.colors.success : th.colors.danger}
              />
              <Text variant="body" style={{ flex: 1 }}>
                {row.text}
              </Text>
              {lost !== null ? <FieldText face="numeral">{`−${lost}`}</FieldText> : null}
            </View>
          );
        })}
      </View>
    </Field>
  );
}
