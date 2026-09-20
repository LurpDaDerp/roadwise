import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text, useTheme } from '@/ui';
import { formatPoints } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { standingLabel, type EventStanding, type TimelineRow } from './detail';
import { Field, FieldText } from './Field';
import { CLOCK_COLUMN, ICON, TIGHT, TOUCH } from './layout';

/** The glyph beside each standing, so no state on the timeline rides on colour (§14). */
const GLYPH: Record<EventStanding, keyof typeof Ionicons.glyphMap> = {
  counted: 'remove-circle-outline',
  possible: 'help-circle-outline',
  reportSending: 'cloud-upload-outline',
  reportAccepted: 'checkmark-circle-outline',
  reportRecorded: 'chatbox-ellipses-outline',
  reportClosed: 'time-outline',
  reportRefused: 'alert-circle-outline',
  reportUnsent: 'cloud-offline-outline',
  removed: 'close-circle-outline',
  free: 'ellipse-outline',
};

/** Everything one row says, in the order it is spoken. */
export function spokenRow(row: TimelineRow): string {
  const parts: string[] = [row.clock, row.title, row.measured];
  if (row.severity !== 'none') parts.push(copy.severity[row.severity]);
  if (row.points !== null) parts.push(copy.highlights.lost(formatPoints(row.points)));
  const standing = standingLabel(row.standing);
  if (standing !== null) parts.push(standing);
  parts.push(copy.confidence[row.confidence]);
  return parts.join(', ');
}

function Row({
  row,
  first,
  onPress,
  testID,
}: {
  row: TimelineRow;
  first: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  const standing = standingLabel(row.standing);
  const counted = row.points !== null;
  const ink = counted ? th.colors.text : th.colors.textMuted;

  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={spokenRow(row)}
      accessibilityHint={copy.events.hint}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: th.space.md,
        minHeight: TOUCH,
        paddingVertical: th.space.md,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: th.colors.divider,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <FieldText face="numeral" variant="footnote" tone="muted" style={{ minWidth: CLOCK_COLUMN }}>
        {row.clock}
      </FieldText>

      <View style={{ flex: 1, gap: TIGHT }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }}>
          <Ionicons
            name={GLYPH[row.standing]}
            size={ICON.sm}
            color={counted ? th.colors.danger : th.colors.textSubtle}
          />
          <Text variant="headline" style={{ color: ink, flexShrink: 1 }}>
            {row.title}
          </Text>
          {row.severity !== 'none' ? (
            <Text variant="caption" tone="muted">
              {copy.severity[row.severity]}
            </Text>
          ) : null}
        </View>
        <Text variant="subhead" tone="muted">
          {row.measured}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}>
          {standing !== null ? (
            <Text variant="caption" tone="subtle">
              {standing}
            </Text>
          ) : null}
          <Text variant="caption" tone="subtle">
            {copy.confidence[row.confidence]}
          </Text>
        </View>
      </View>

      <FieldText face="numeral" variant="body" tone={counted ? 'default' : 'subtle'}>
        {row.points === null ? '—' : `−${formatPoints(row.points)}`}
      </FieldText>
    </Pressable>
  );
}

/**
 * The timeline (§7.D D2): **the primary representation of the drive**, not a caption under the
 * map. Every event in the order it happened, with its clock time, what was measured, how sure the
 * app is, what it cost, and — for the events that cost nothing — why they did not.
 *
 * Low-confidence events are on this list, labelled "Detected, not counted" (§9.4): D1 leaves them
 * out of its episode counts precisely because they do not affect the score, and the honest place
 * to show them is here, where the driver can see everything the phone noticed and tap through to
 * ask about any of it.
 */
export function TripTimeline({
  rows,
  onOpen,
  testID,
}: {
  rows: readonly TimelineRow[];
  onOpen: (eventId: string) => void;
  testID?: string;
}) {
  return (
    <Field label={copy.detail.timelineLabel} testID={testID}>
      <View accessibilityRole="list">
        {rows.map((row, index) => (
          <Row
            key={row.event.id}
            row={row}
            first={index === 0}
            onPress={() => onOpen(row.event.id)}
            testID={`timeline-${row.event.id}`}
          />
        ))}
      </View>
    </Field>
  );
}
