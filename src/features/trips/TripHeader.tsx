import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import type { TripSummary } from '@/data/queries';
import { formatDistanceMi, formatDuration } from '@/lib/format';
import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import { conditionsLabel, dateLine, routeLine } from './format';
import { TripStatusChip } from './TripStatusChip';

/**
 * The top of the card back (§7.D D1 header): the route line, the date and times in the trip's
 * own zone, and three printed splits — time, distance, conditions. Night and rain carry a glyph
 * beside their word. The "Will sync" and "Recovered" chips sit with the route line, where a
 * driver checking on an upload looks first.
 */
export function TripHeader({ trip }: { trip: TripSummary }) {
  const th = useTheme();
  const { night, precipitation } = trip.conditions;
  const conditionIcon: keyof typeof Ionicons.glyphMap | null = night
    ? 'moon-outline'
    : precipitation
      ? 'rainy-outline'
      : null;

  return (
    <View style={{ gap: th.space.md }}>
      <View style={{ gap: th.space.xs }}>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            gap: th.space.sm,
          }}
        >
          <Text variant="title2" style={{ flexGrow: 1, flexShrink: 1, minWidth: '60%' }}>
            {routeLine(trip)}
          </Text>
          {trip.pendingSync ? <TripStatusChip kind="willSync" testID="chip-will-sync" /> : null}
          {trip.incomplete ? <TripStatusChip kind="recovered" testID="chip-recovered" /> : null}
        </View>
        <Text variant="footnote" tone="muted">
          {dateLine(trip)}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
        <Field label={copy.splits.time} style={{ flexGrow: 1, minWidth: 72 }}>
          <FieldText face="numeral">{formatDuration(trip.durationS)}</FieldText>
        </Field>
        <Field label={copy.splits.distance} style={{ flexGrow: 1, minWidth: 72 }}>
          <FieldText face="numeral">{formatDistanceMi(trip.distanceM)}</FieldText>
        </Field>
        <Field label={copy.splits.conditions} style={{ flexGrow: 1, minWidth: 72 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }}>
            {conditionIcon ? (
              <Ionicons name={conditionIcon} size={16} color={th.colors.textMuted} />
            ) : null}
            <FieldText>{conditionsLabel(trip)}</FieldText>
          </View>
        </Field>
      </View>
    </View>
  );
}
