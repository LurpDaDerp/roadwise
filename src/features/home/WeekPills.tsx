import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, View, type TextStyle } from 'react-native';

import type { MySummary } from '@/data/server/summary';
import { distanceIn, formatDistance, type Units } from '@/lib/units';
import { Text, useTheme } from '@/ui';

import { homeCopy } from './copy';

/**
 * One pill in the row under the greeting: paper, round-ended, read as one phrase. With `onPress` it
 * is a button (a hint says where it goes); without, it is static.
 */
export function StatPill({
  children,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  testID,
}: {
  children: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  onPress?: () => void;
  testID?: string;
}) {
  const t = useTheme();
  const style = {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.xs,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.sm,
    borderRadius: t.radius.pill,
    borderCurve: 'continuous',
    backgroundColor: t.colors.surface,
    borderWidth: t.scheme === 'dark' ? 1 : 0,
    borderColor: t.colors.divider,
    boxShadow: t.elevation.card,
  } as const;
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        style={({ pressed }) => [style, { opacity: pressed ? 0.8 : 1 }]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View testID={testID} accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel} style={style}>
      {children}
    </View>
  );
}

/** A week's distance as the pill says it: whole from 10 up and for none, one decimal between ("38 mi", "4.2 mi", "0 mi"). */
export function weekDistance(miles: number, units: Units, spoken = false): string {
  const d = distanceIn(miles, units);
  return formatDistance(miles, units, { digits: d >= 10 || d <= 0 ? 0 : 1, spoken });
}

/** This week's weekly goals done, of how many (null with none assigned). */
export function goalsDone(challenges: readonly MySummary['challenges'][number][] | undefined): { done: number; total: number } | null {
  if (!challenges || challenges.length === 0) return null;
  return { done: challenges.filter((c) => c.completed).length, total: challenges.length };
}

/**
 * The row under the greeting: this week's drives and distance (local, since Monday) in two pills,
 * and the weekly goals done (the server's) in a third, which hides while there are none. They sit
 * on one row at the default text size (a 375 pt phone and up) and wrap onto the next at large text. With `onGoals` the goals pill is a button.
 */
export function WeekPills({
  drives,
  miles,
  units,
  goals,
  onGoals,
}: {
  drives: number;
  miles: number;
  units: Units;
  goals: { done: number; total: number } | null;
  /** Taps the goals pill (omit when the goals section is not on the screen). */
  onGoals?: () => void;
}) {
  const t = useTheme();
  const text: TextStyle = { fontVariant: ['tabular-nums'] };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, paddingVertical: t.space.xs }} testID="home-week">
      <StatPill accessibilityLabel={homeCopy.week.drivesSpoken(drives)} testID="home-week-drives">
        <Ionicons name="car-sport" size={t.size.icon} color={t.colors.text} accessible={false} />
        <Text variant="title3" style={text}>
          {homeCopy.week.drives(drives)}
        </Text>
      </StatPill>
      <StatPill accessibilityLabel={homeCopy.week.distanceSpoken(weekDistance(miles, units, true))} testID="home-week-distance">
        <Ionicons name="map" size={t.size.icon} color={t.colors.text} accessible={false} />
        <Text variant="title3" style={text}>
          {weekDistance(miles, units)}
        </Text>
      </StatPill>
      {goals ? (
        <StatPill
          accessibilityLabel={homeCopy.week.goalsSpoken(goals.done, goals.total)}
          accessibilityHint={onGoals ? homeCopy.week.goalsHint : undefined}
          onPress={onGoals}
          testID="home-week-goals"
        >
          <Ionicons name="checkmark-circle" size={t.size.icon} color={t.colors.signal.clean.text} accessible={false} />
          <Text variant="title3" style={text}>
            {homeCopy.week.goals(goals.done, goals.total)}
          </Text>
        </StatPill>
      ) : null}
    </View>
  );
}
