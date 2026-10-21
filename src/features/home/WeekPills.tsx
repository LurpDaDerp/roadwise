import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import type { MySummary } from '@/data/server/summary';
import { distanceIn, formatDistance, type Units } from '@/lib/units';
import { Text, useTheme } from '@/ui';

import { homeCopy } from './copy';

/** One pill in the row under the greeting: paper, round-ended, read as one phrase. */
export function StatPill({ children, accessibilityLabel, testID }: { children: ReactNode; accessibilityLabel?: string; testID?: string }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      style={{
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.sm,
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.sm,
        borderRadius: t.radius.pill,
        borderCurve: 'continuous',
        backgroundColor: t.colors.surface,
        borderWidth: t.scheme === 'dark' ? 1 : 0,
        borderColor: t.colors.divider,
        boxShadow: t.elevation.card,
      }}
    >
      {children}
    </View>
  );
}

/** A week's distance as the pill says it: whole from 10 up, one decimal under ("38 mi", "4.2 mi"). */
export function weekDistance(miles: number, units: Units, spoken = false): string {
  return formatDistance(miles, units, { digits: distanceIn(miles, units) >= 10 ? 0 : 1, spoken });
}

/** This week's weekly goals done, of how many (null with none assigned). */
export function goalsDone(challenges: readonly MySummary['challenges'][number][] | undefined): { done: number; total: number } | null {
  if (!challenges || challenges.length === 0) return null;
  return { done: challenges.filter((c) => c.completed).length, total: challenges.length };
}

/**
 * The row under the greeting: this week's drives and distance (local, since Monday), and the weekly
 * goals done (the server's). Both static; the goals pill hides while there are none.
 */
export function WeekPills({ drives, miles, units, goals }: { drives: number; miles: number; units: Units; goals: { done: number; total: number } | null }) {
  const t = useTheme();
  const dist = weekDistance(miles, units);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -t.space.lg, overflow: 'visible' }}
      contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.lg, paddingVertical: t.space.xs }}
      testID="home-week"
    >
      <StatPill accessibilityLabel={homeCopy.week.drivesSpoken(drives, weekDistance(miles, units, true))} testID="home-week-drives">
        <Ionicons name="car-sport" size={t.size.icon} color={t.colors.text} accessible={false} />
        <Text variant="title3" style={{ fontVariant: ['tabular-nums'] }}>
          {homeCopy.week.drives(drives, dist)}
        </Text>
      </StatPill>
      {goals ? (
        <StatPill accessibilityLabel={homeCopy.week.goalsSpoken(goals.done, goals.total)} testID="home-week-goals">
          <Ionicons name="checkmark-circle" size={t.size.icon} color={t.colors.signal.clean.text} accessible={false} />
          <Text variant="title3" style={{ fontVariant: ['tabular-nums'] }}>
            {homeCopy.week.goals(goals.done, goals.total)}
          </Text>
        </StatPill>
      ) : null}
    </ScrollView>
  );
}
