import { View } from 'react-native';

import type { DayEntry, TripSummary } from '@/data/queries';
import { useDayAward } from '@/features/rewards/useRewards';
import { Skeleton, Text, useTheme } from '@/ui';
import { Stamp } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import { earnedView, type EarnedView } from './format';

function EarnedBody({ view }: { view: EarnedView }) {
  const th = useTheme();
  if (view.kind === 'settled') {
    // One reading for the rotor: tier, the day's points "for the day", then the streak.
    const spoken = view.streak === null ? view.spoken : `${view.spoken}. ${view.streak}`;
    return (
      <View style={{ gap: th.space.xs }}>
        <View accessible accessibilityRole="text" accessibilityLabel={spoken} testID="earned-settled">
          {view.stamp ? (
            <View style={{ paddingVertical: th.space.xs }} importantForAccessibility="no-hide-descendants">
              {/* One slam when it lands; still under reduce motion (the stamp's own rule). */}
              <Stamp kind="safeDay" testID="stamp-safe-day" />
            </View>
          ) : null}
          <FieldText variant="headline">
            {view.headline}
          </FieldText>
          {view.streak === null ? null : (
            <Text variant="subhead" tone="muted">
              {view.streak}
            </Text>
          )}
        </View>
        <Text variant="footnote" tone="subtle">
          {view.note}
        </Text>
      </View>
    );
  }
  if (view.kind === 'nothing') {
    return (
      <FieldText variant="headline" style={{ fontWeight: '400' }}>
        {view.headline}
      </FieldText>
    );
  }
  return (
    <>
      <FieldText variant="headline" style={{ fontWeight: '400' }}>
        {view.headline}
      </FieldText>
      <Text variant="footnote" tone="muted">
        {view.note}
      </Text>
    </>
  );
}

/**
 * The EARNED field (§7.D D1 item 5) once rewards exist: the day's confirmed tier and points with the
 * streak after it, or — until the day is confirmed — M2's "on track" words and settle rule; a day
 * outside the rewards says why. The award comes from Task 7's `useDayAward` (three ways, and
 * unknown while offline without a saved answer); the frozen late day is Task 7's to tell apart.
 */
export function DayEarnedField({ trip, day }: { trip: TripSummary; day: DayEntry | null }) {
  const award = useDayAward(trip.day);
  return (
    <Field label={copy.earned.label} testID="earned">
      {award.status === 'pending' ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.earned.checking} testID="earned-loading">
          <Skeleton width="60%" height={22} />
        </View>
      ) : (
        <EarnedBody view={earnedView(trip, day, award.status === 'error' ? 'unknown' : award.data)} />
      )}
    </Field>
  );
}
