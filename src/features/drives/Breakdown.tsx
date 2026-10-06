import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Card, Divider, Text, useTheme } from '@/ui';

import { EVENT_ICON, TIER_SIGNAL } from './format';
import type { LocalDriveEvent } from './model';
import { canReport, disputeText, isRemoved, type BreakdownLine, type LineTone } from './summary';

/** The "Breakdown ▾" control under the points. The list it opens renders right below. */
export function BreakdownToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID="breakdown-toggle"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Breakdown"
      accessibilityHint={open ? 'Hides how these points add up' : 'Shows how these points add up'}
      accessibilityState={{ expanded: open }}
      hitSlop={t.space.xs}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: t.space.xs,
        minHeight: t.size.touch,
        paddingHorizontal: t.space.md,
        borderRadius: t.radius.pill,
        backgroundColor: pressed ? t.colors.surfaceRaised : t.colors.surface,
      })}
    >
      <Text variant="subhead" style={{ fontWeight: '600' }}>
        Breakdown
      </Text>
      <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={t.size.iconSm} color={t.colors.text} />
    </Pressable>
  );
}

function useToneColor(tone: LineTone): string {
  const t = useTheme();
  return tone === 'gain' ? t.colors.signal.clean.text : tone === 'loss' ? t.colors.signal.severe.text : t.colors.textMuted;
}

function PlainLine({ line }: { line: Extract<BreakdownLine, { kind: 'miles' | 'bonus' | 'mult' | 'net' }> }) {
  const t = useTheme();
  const color = useToneColor(line.tone);
  const net = line.kind === 'net';
  return (
    <View
      testID={`line-${line.key}`}
      accessible
      accessibilityLabel={`${line.label}, ${line.value.replace('−', 'minus ')}`}
      style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.md, paddingVertical: t.space.sm }}
    >
      <Text variant={net ? 'headline' : 'callout'} style={{ flex: 1 }}>
        {line.label}
      </Text>
      <Text variant={net ? 'stat' : 'headline'} style={{ color, fontVariant: ['tabular-nums'] }}>
        {line.value}
      </Text>
    </View>
  );
}

function EventLine({
  line,
  selected,
  onSelect,
  onReport,
}: {
  line: Extract<BreakdownLine, { kind: 'event' }>;
  selected: boolean;
  onSelect: () => void;
  onReport: () => void;
}) {
  const t = useTheme();
  const e: LocalDriveEvent = line.event;
  const sig = t.colors.signal[TIER_SIGNAL[e.tier]];
  const color = useToneColor(line.tone);
  const status = disputeText(e);
  const removed = isRemoved(e);
  return (
    <View
      style={{
        marginHorizontal: -t.space.sm,
        paddingHorizontal: t.space.sm,
        borderRadius: t.radius.md,
        backgroundColor: selected ? t.colors.accentFaint : 'transparent',
      }}
    >
      <Pressable
        testID={line.key}
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={`${line.time}, ${line.label}, ${line.value.replace('−', 'minus ')}${line.value === 'Removed' ? '' : ' points'}`}
        accessibilityHint="Circles it on the route map"
        accessibilityState={{ selected }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, minHeight: t.size.touch, paddingTop: t.space.sm }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: sig.faint,
          }}
        >
          <Ionicons name={EVENT_ICON[e.type]} size={t.size.iconSm} color={sig.text} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="callout" style={removed ? { textDecorationLine: 'line-through' } : undefined}>
            {line.label}
          </Text>
          <Text variant="footnote" tone="subtle">
            {line.time}
          </Text>
        </View>
        <Text variant="headline" style={{ color, fontVariant: ['tabular-nums'] }}>
          {line.value}
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 28 + t.space.md, minHeight: 32 }}>
        {canReport(e) ? (
          <Pressable
            testID={`report-${e.id}`}
            onPress={onReport}
            accessibilityRole="button"
            accessibilityLabel={`Report ${line.label} at ${line.time}`}
            hitSlop={{ top: 6, bottom: 6, left: 8, right: 16 }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: t.space.xs })}
          >
            <Text variant="footnote" tone="accent" style={{ fontWeight: '600', textDecorationLine: 'underline' }}>
              Report
            </Text>
          </Pressable>
        ) : status ? (
          <Text variant="footnote" tone="muted" testID={`dispute-${e.id}`}>
            {status}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** The itemized list: miles, bonus, multiplier, one line per event (tap → map, Report), net. */
export function BreakdownList({
  lines,
  note,
  selectedId,
  onSelect,
  onReport,
}: {
  lines: readonly BreakdownLine[];
  note: string | null;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
  onReport: (eventId: string) => void;
}) {
  const t = useTheme();
  return (
    <Animated.View entering={t.reduceMotion ? undefined : FadeIn.duration(t.motion.base)} testID="breakdown">
      <Card padded style={{ gap: 0 }}>
        {lines.map((line, i) => (
          <View key={line.key}>
            {line.kind === 'net' && i > 0 ? <Divider style={{ marginVertical: t.space.xs }} /> : null}
            {line.kind === 'event' ? (
              <EventLine
                line={line}
                selected={selectedId === line.event.id}
                onSelect={() => onSelect(line.event.id)}
                onReport={() => onReport(line.event.id)}
              />
            ) : (
              <PlainLine line={line} />
            )}
          </View>
        ))}
        {lines.every((l) => l.kind !== 'event') && lines.length > 0 ? (
          <Text variant="footnote" tone="muted" style={{ paddingTop: t.space.xs }}>
            No events on this drive.
          </Text>
        ) : null}
        {note ? (
          <Text variant="footnote" tone="muted" style={{ paddingTop: t.space.sm }}>
            {note}
          </Text>
        ) : null}
      </Card>
    </Animated.View>
  );
}
