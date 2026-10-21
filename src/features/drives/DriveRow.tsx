import { Ionicons } from '@expo/vector-icons';
import { driveMerit, type EventType } from '@scoring';
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { formatDistance } from '@/lib/units';
import { Text, useTheme } from '@/ui';

import { recapCopy } from './copy';
import { EventIcon } from './EventIcon';
import { EVENT_LABEL, formatDuration, formatWhen, routeLine, spokenRoute } from './format';
import { meritInk } from './merit';
import type { DriveCounts, LocalDrive } from './model';
import { decodeRoute } from './route';
import { RouteSketch } from './RouteSketch';
import { driveKind, stateWord } from './summary';

const COUNT_TYPES: [keyof DriveCounts, EventType][] = [
  ['speeding', 'speeding'],
  ['hardBrake', 'hard_brake'],
  ['hardAccel', 'hard_accel'],
  ['hardCorner', 'hard_corner'],
  ['pickups', 'phone_pickup'],
  ['eyesOff', 'eyes_off'],
  ['drowsy', 'drowsy'],
];

/** The event types present on a drive with how many of each, in a fixed order. */
export function eventTally(counts: DriveCounts): { type: EventType; n: number }[] {
  return COUNT_TYPES.filter(([k]) => counts[k] > 0).map(([k, type]) => ({ type, n: counts[k] }));
}

/**
 * One drive in a list: when, where, a route sketch, distance, time and its events, with its score
 * at the right in its merit tier's colour (no icon; "not synced" under a drive still to upload), or
 * the word for why it has none. `score` is the drive's (`useDriveScores`); absent while it loads.
 */
export function DriveRow({ drive, score, onPress, testID }: { drive: LocalDrive; score?: number | null; onPress: () => void; testID?: string }) {
  const t = useTheme();
  const units = useUnits();
  const runs = useMemo(() => decodeRoute(drive.polyline), [drive.polyline]);
  const kind = driveKind(drive);
  const scorable = kind.kind === 'scorable';
  const value = scorable && typeof score === 'number' ? score : null;
  const word = scorable ? (score === null ? stateWord({ kind: 'not_scored' }) : null) : stateWord(kind);
  const tier = value === null ? null : driveMerit(value, drive.miles);
  const ink = tier === null ? t.colors.text : meritInk(tier, [t.colors.surface, t.colors.surfaceRaised]);
  const tally = eventTally(drive.counts);
  const clean = drive.clean === true && tally.length === 0 && scorable;

  const spoken = [
    formatWhen(drive.startedAt),
    spokenRoute(drive),
    formatDistance(drive.miles, units, { spoken: true }),
    value !== null ? `drive score ${value}${kind.kind === 'scorable' && kind.notSynced ? ', not synced' : ''}` : word,
    clean ? 'clean drive' : tally.map((x) => `${x.n} ${EVENT_LABEL[x.type].toLowerCase()}`).join(', ') || null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the drive summary"
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
      <RouteSketch runs={runs} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline" numberOfLines={1}>
          {formatWhen(drive.startedAt)}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={1}>
          {routeLine(drive)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: t.space.sm, rowGap: 2 }}>
          <Text variant="footnote" tone="subtle">
            {formatDistance(drive.miles, units)} · {formatDuration(drive.durationS)}
          </Text>
          {clean ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Ionicons name="checkmark-circle" size={14} color={t.colors.signal.clean.text} />
              <Text variant="footnote" style={{ color: t.colors.signal.clean.text }}>
                Clean
              </Text>
            </View>
          ) : (
            tally.map((x) => (
              <View key={x.type} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }} testID={`${testID ?? 'row'}-event-${x.type}`}>
                <EventIcon type={x.type} size={14} color={t.colors.textMuted} />
                {x.n > 1 ? (
                  <Text variant="footnote" tone="muted">
                    {x.n}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        {value !== null ? (
          <>
            <Text variant="stat" style={{ color: ink }} testID={testID ? `${testID}-score` : undefined}>
              {value}
            </Text>
            <Text variant="label" tone="subtle" style={{ textTransform: 'none' }}>
              {kind.kind === 'scorable' && kind.notSynced ? recapCopy.history.notSynced : recapCopy.history.score}
            </Text>
          </>
        ) : word ? (
          <Text variant="footnote" tone="muted" testID={testID ? `${testID}-word` : undefined}>
            {word}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
