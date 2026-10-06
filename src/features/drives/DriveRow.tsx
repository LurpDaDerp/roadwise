import { Ionicons } from '@expo/vector-icons';
import type { EventType } from '@scoring';
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { formatDistance } from '@/lib/units';
import { Text, useTheme } from '@/ui';

import { EVENT_ICON, EVENT_LABEL, formatDuration, formatWhen, routeLine, signedPoints, spokenRoute } from './format';
import type { DriveCounts, LocalDrive } from './model';
import { decodeRoute } from './route';
import { RouteSketch } from './RouteSketch';
import { pointsState, pointsWord } from './summary';

const COUNT_TYPES: [keyof DriveCounts, EventType][] = [
  ['speeding', 'speeding'],
  ['pickups', 'phone_pickup'],
  ['hardBrake', 'hard_brake'],
  ['hardAccel', 'hard_accel'],
  ['hardCorner', 'hard_corner'],
  ['eyesOff', 'eyes_off'],
  ['drowsy', 'drowsy'],
];

/** The event types present on a drive with how many of each, in a fixed order. */
export function eventTally(counts: DriveCounts): { type: EventType; n: number }[] {
  return COUNT_TYPES.filter(([k]) => counts[k] > 0).map(([k, type]) => ({ type, n: counts[k] }));
}

function spokenPoints(n: number): string {
  if (n > 0) return `${n} points earned`;
  if (n < 0) return `${Math.abs(n)} points lost`;
  return 'no points';
}

/** One drive in a list: when, where, a route sketch, distance, net points and its events. */
export function DriveRow({ drive, onPress, testID }: { drive: LocalDrive; onPress: () => void; testID?: string }) {
  const t = useTheme();
  const units = useUnits();
  const points = useMemo(() => decodeRoute(drive.polyline), [drive.polyline]);
  const state = pointsState(drive);
  const word = pointsWord(state);
  const tally = eventTally(drive.counts);
  const value = state.kind === 'points' ? state.value : null;
  const tone = value === null || value === 0 ? t.colors.textMuted : value > 0 ? t.colors.signal.clean.text : t.colors.signal.severe.text;
  const clean = drive.clean === true && tally.length === 0 && state.kind === 'points';

  const spoken = [
    formatWhen(drive.startedAt),
    spokenRoute(drive),
    formatDistance(drive.miles, units, { spoken: true }),
    value !== null ? spokenPoints(value) + (state.kind === 'points' && state.estimate ? ', estimate' : '') : word,
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
      <RouteSketch points={points} />
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
                <Ionicons name={EVENT_ICON[x.type]} size={14} color={t.colors.textMuted} />
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
            <Text variant="stat" style={{ color: tone }} testID={testID ? `${testID}-points` : undefined}>
              {signedPoints(value)}
            </Text>
            <Text variant="label" tone="subtle">
              {state.kind === 'points' && state.estimate ? 'est. pts' : 'pts'}
            </Text>
          </>
        ) : (
          <Text variant="footnote" tone="muted" testID={testID ? `${testID}-word` : undefined}>
            {word}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
