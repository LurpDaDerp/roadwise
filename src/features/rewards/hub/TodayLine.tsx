import { useMemo } from 'react';

import { useDataSource, useScoreDaily, type DayEntry } from '@/data/queries';
import { dayKind } from '@/features/insights/format';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Text } from '@/ui';

import type { Progress, RewardDay } from '../api';
import { hubCopy as copy } from '../copy/hub';
import { dayAward } from '../viewModel';

/**
 * Today's line, from today's day row so far, or null for nothing to say. Classified by the shared
 * day predicate (`dayKind`): no counted drive → nothing, never a nudge to drive; a day whose drives
 * were all deleted is not safe and says why (D2). Every line ends "Confirmed when the day closes."
 * — nothing is earned before it is.
 */
export function todayLineText(day: DayEntry | undefined): string | null {
  if (day === undefined || day.unreadable) return null;
  switch (dayKind(day)) {
    case 'none':
      return null;
    case 'safe':
      return copy.today.safe;
    case 'not_safe':
      if (day.tripsScored === 0) return copy.today.deleted;
      return day.goodDay ? copy.today.good : copy.today.notSafe;
  }
}

/**
 * Today's line is said only while today is still `pending` for rewards (`dayAward`, T7 round 1): a
 * day that will not count (before the account's rewards began) is never told "Confirmed when the
 * day closes", and a day already confirmed has nothing "so far" about it.
 */
export function TodayLine({
  tz,
  progress,
  settledDays,
}: {
  tz?: string;
  progress: Progress | null;
  /** The snapshot's settled days (newest 35), which hold today's row if it has one. */
  settledDays: readonly RewardDay[];
}) {
  const { now } = useDataSource();
  const today = dayKey(new Date(now()), tz ?? deviceZone());
  const range = useMemo(() => ({ from: today, to: today }), [today]);
  const days = useScoreDaily(range);
  const award = dayAward(settledDays.find((d) => d.day === today) ?? null, { day: today, progress });
  if (award.status !== 'pending') return null;
  const text = todayLineText(days.data?.find((d) => d.day === today));
  if (text === null) return null;
  return (
    <Text variant="subhead" tone="muted" testID="hub-today">
      {text}
    </Text>
  );
}
