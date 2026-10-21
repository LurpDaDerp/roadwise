import { isDashcamType } from '@scoring';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Divider, Text, useTheme } from '@/ui';

import { recapCopy } from './copy';
import { EventIcon } from './EventIcon';
import { TIER_SIGNAL } from './format';
import { availableReasons, canReport, disputeText, EVENT_LIST_MAX, isRemoved, type EventRow } from './summary';

function EventLine({
  row,
  selected,
  reportable,
  onSelect,
  onReport,
}: {
  row: EventRow;
  selected: boolean;
  /** Report shows: the event was never reported and some reason fits it now. */
  reportable: boolean;
  onSelect: () => void;
  onReport: () => void;
}) {
  const t = useTheme();
  const e = row.event;
  const removed = isRemoved(e);
  const status = disputeText(e);
  const ink = isDashcamType(e.type) ? t.colors.textMuted : t.colors.signal[TIER_SIGNAL[e.tier]].text;
  return (
    <View
      style={{
        marginHorizontal: -t.space.sm,
        paddingHorizontal: t.space.sm,
        paddingVertical: t.space.xs,
        borderRadius: t.radius.md,
        backgroundColor: selected ? t.colors.accentFaint : 'transparent',
      }}
    >
      <Pressable
        testID={row.key}
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={`${row.label} at ${row.time}${row.detail ? `, ${row.detail.spoken}` : ''}${removed ? ', removed' : ''}`}
        accessibilityHint={recapCopy.events.selectHint}
        accessibilityState={{ selected }}
        hitSlop={{ top: 4, bottom: 4 }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, minHeight: 36, paddingTop: t.space.xs }}
      >
        <EventIcon type={e.type} size={20} color={ink} />
        <Text variant="callout" style={[{ flex: 1 }, removed ? { textDecorationLine: 'line-through' } : null]}>
          {row.label}
        </Text>
        <Text variant="footnote" tone="subtle" accessibilityElementsHidden importantForAccessibility="no">
          {row.time}
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: t.space.sm, minHeight: 28, paddingLeft: 20 + t.space.md }}>
        {row.detail ? (
          // Spoken with the row's name above, so a screen reader doesn't read it twice.
          <Text
            variant="footnote"
            tone="muted"
            testID={`event-detail-${e.id}`}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={removed ? { textDecorationLine: 'line-through' } : null}
          >
            {row.detail.text}
          </Text>
        ) : null}
        {reportable ? (
          <Pressable
            testID={`report-${e.id}`}
            onPress={onReport}
            accessibilityRole="button"
            accessibilityLabel={`Report ${row.label} at ${row.time}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 16 }}
            style={({ pressed }) => ({ paddingVertical: t.space.xs, opacity: pressed ? 0.6 : 1 })}
          >
            <Text variant="footnote" tone="accent" style={{ fontWeight: '600', textDecorationLine: 'underline' }}>
              {recapCopy.events.report}
            </Text>
          </Pressable>
        ) : status ? (
          <Text variant="footnote" tone="muted" testID={`dispute-${e.id}`} style={{ flexShrink: 1 }}>
            {status}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export type EventListProps = {
  rows: readonly EventRow[];
  /** "I wasn't driving" can be a report's reason here (the whole-drive action is allowed). */
  allowNotDriving?: boolean;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
  onReport: (eventId: string) => void;
};

/**
 * The drive's events under its score: one row each, oldest first, its icon in its tier's ink, its
 * name and time, and under it a phone pickup's time in hand and speed, then Report (or the
 * report's status). A tap circles it on the route map. Three show before "Show more"; a clean drive
 * says so.
 */
export function EventList({ rows, allowNotDriving = false, selectedId, onSelect, onReport }: EventListProps) {
  const t = useTheme();
  const [all, setAll] = useState(false);
  const hidden = rows.length - EVENT_LIST_MAX;
  const shown = all || hidden <= 0 ? rows : rows.slice(0, EVENT_LIST_MAX);
  return (
    <View testID="event-list" style={{ gap: t.space.xs }}>
      <Text variant="label" tone="muted" accessibilityRole="header" accessibilityLabel={recapCopy.events.spokenTitle(rows.length)} testID="event-list-title">
        {recapCopy.events.title(rows.length)}
      </Text>
      {rows.length === 0 ? (
        <Text variant="callout" tone="muted" testID="event-list-none" style={{ paddingVertical: t.space.sm }}>
          {recapCopy.events.none}
        </Text>
      ) : (
        shown.map((row, i) => (
          <View key={row.key}>
            {i > 0 ? <Divider /> : null}
            <EventLine
              row={row}
              selected={selectedId === row.event.id}
              reportable={canReport(row.event) && availableReasons(row.event.type, allowNotDriving).length > 0}
              onSelect={() => onSelect(row.event.id)}
              onReport={() => onReport(row.event.id)}
            />
          </View>
        ))
      )}
      {hidden > 0 ? (
        <Button
          label={all ? recapCopy.events.less : recapCopy.events.more}
          icon={all ? 'chevron-up' : 'chevron-down'}
          variant="ghost"
          size="sm"
          onPress={() => setAll((v) => !v)}
          accessibilityHint={all ? recapCopy.events.lessHint : recapCopy.events.moreHint(hidden)}
          testID="event-list-more"
          style={{ alignSelf: 'flex-start', marginTop: t.space.xs }}
        />
      ) : null}
    </View>
  );
}
