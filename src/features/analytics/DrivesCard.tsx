import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import type { LocalDrive } from '@/data/queries/rows';
import { useUnits } from '@/data/queries/units';
import { eventTally } from '@/features/drives/DriveRow';
import { formatWhen } from '@/features/drives/format';
import type { Units } from '@/lib/units';
import { Button, Card, Divider, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { distanceMetric, timeMetric } from './format';

/** Rows shown at first, and added by each "Show more". */
export const DRIVES_PAGE = 10;

const c = analyticsCopy.drives;

/** "12.0 mi · 24 min · 2 events", and the same in words. */
export function driveLine(d: LocalDrive, units: Units): { text: string; spoken: string } {
  const dist = distanceMetric(d.miles, units);
  const time = timeMetric(d.durationS);
  const events = eventTally(d.counts).reduce((n, x) => n + x.n, 0);
  const tail = events > 0 ? `${events} ${events === 1 ? 'event' : 'events'}` : d.clean === true ? c.clean : c.noEvents;
  return {
    text: [`${dist.value} ${dist.unit}`, `${time.value} ${time.unit}`, tail].join(' · '),
    spoken: [dist.spoken, time.spoken, tail].join(', '),
  };
}

function Row({ drive, onPress }: { drive: LocalDrive; onPress: () => void }) {
  const t = useTheme();
  const units = useUnits();
  const when = formatWhen(drive.startedAt);
  const line = driveLine(drive, units);
  return (
    <Pressable
      testID={`analytics-drive-${drive.clientTripId}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${when}, ${line.spoken}`}
      accessibilityHint={c.hint}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.md,
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.md,
        minHeight: t.size.touch,
        backgroundColor: pressed ? t.colors.surfaceRaised : 'transparent',
      })}
    >
      {/* Both lines wrap at large text: the events at the end of the line still show. */}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline" testID="analytics-drive-when">
          {when}
        </Text>
        <Text variant="footnote" tone="muted" testID="analytics-drive-line">
          {line.text}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={t.size.icon} color={t.colors.textSubtle} />
    </Pressable>
  );
}

/**
 * Every scored drive not past 183 days, behind a "Drives · 12" header that opens and closes the
 * list (closed at first): ten rows, then "Show more" adds ten at a time, so only the rows asked for
 * are drawn however many drives there are. With none listed but older (archived) drives counted
 * elsewhere (`archived`), it says "No drives in the last 6 months" rather than "No drives yet".
 */
export function DrivesCard({ drives, onOpen, archived = false }: { drives: readonly LocalDrive[]; onOpen: (clientTripId: string) => void; archived?: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(DRIVES_PAGE);
  const count = drives.length;
  const title = `${c.title} · ${count}`;
  const canOpen = count > 0;

  return (
    <Card padded={false} testID="analytics-drives">
      <Pressable
        testID="analytics-drives-toggle"
        onPress={canOpen ? () => setOpen((o) => !o) : undefined}
        // With nothing to open it is only the card's heading, read as "Drives, none yet".
        accessibilityRole={canOpen ? 'button' : 'header'}
        accessibilityLabel={count === 0 && archived ? c.spokenArchived : c.spoken(count)}
        accessibilityState={canOpen ? { expanded: open } : undefined}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.space.md,
          padding: t.space.lg,
          minHeight: t.size.touch,
          opacity: pressed && canOpen ? 0.7 : 1,
        })}
      >
        <Text variant="title3" style={{ flex: 1 }}>
          {title}
        </Text>
        {canOpen ? (
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={t.size.icon} color={t.colors.textMuted} />
        ) : (
          <Text variant="subhead" tone="muted" testID="analytics-drives-empty">
            {archived ? c.emptyArchived : c.empty}
          </Text>
        )}
      </Pressable>
      {open && canOpen ? (
        <View testID="analytics-drives-list">
          {drives.slice(0, shown).map((d) => (
            <View key={d.clientTripId}>
              <Divider inset={16} />
              <Row drive={d} onPress={() => onOpen(d.clientTripId)} />
            </View>
          ))}
          {shown < count ? (
            <View style={{ padding: t.space.lg, paddingTop: t.space.sm }}>
              <Button label={c.showMore} variant="secondary" onPress={() => setShown((n) => n + DRIVES_PAGE)} testID="analytics-drives-more" />
            </View>
          ) : (
            <View style={{ height: t.space.sm }} />
          )}
        </View>
      ) : null}
    </Card>
  );
}
