import { View } from 'react-native';

import { useInsights, useScoreDaily, useTrips } from '@/data/queries';
import { Button, Card, EmptyState, Screen, Text, useTheme } from '@/ui';
import { formatScore } from '@/ui/charts';

import { InsightsSkeleton, ReadError, TopBar } from './Chrome';
import { insightsCopy as copy } from './copy';
import { Field, FieldText, Rule } from './Field';
import { formatHours, formatMiles, totalsFor, weekLongLabel, windowOf } from './format';
import { PeriodSelector } from './PeriodSelector';
import type { InsightsPeriod } from './period';

/**
 * E3 — totals and records (§7.E E3). Descriptive only (§10.1): nothing here is a target, nothing
 * is compared with another driver, and no number on this page earns a point, a badge or a level.
 * Distance and trip count in particular never become goals — §10.1 forbids rewarding mileage.
 */
export function TotalsScreen({
  period,
  onPeriodChange,
}: {
  period: InsightsPeriod;
  onPeriodChange: (period: InsightsPeriod) => void;
}) {
  const th = useTheme();
  const insightsQuery = useInsights(period);
  const window = insightsQuery.data ? windowOf(insightsQuery.data) : null;
  // Every drive the driver made, windowed by `totalsFor`: one cache entry for all four periods.
  const tripsQuery = useTrips({ role: 'driver' });
  const daysQuery = useScoreDaily(window?.days ?? { from: '', to: '' });

  if (insightsQuery.isPending) {
    return (
      <Screen scroll>
        <TopBar title={copy.totals.title} />
        <InsightsSkeleton testID="insights-skeleton" />
      </Screen>
    );
  }

  if (insightsQuery.error || !insightsQuery.data || window === null) {
    return (
      <Screen>
        <TopBar title={copy.totals.title} />
        <ReadError onRetry={() => void insightsQuery.refetch()} />
      </Screen>
    );
  }

  const totals = totalsFor({
    trips: tripsQuery.data ?? [],
    days: daysQuery.data ?? [],
    trend: insightsQuery.data.trend,
    from: window.from,
    to: window.to,
  });

  const record: { key: string; label: string; value: string; spoken?: string }[] = [
    { key: 'drives', label: copy.totals.fields.drives, value: String(totals.drives) },
    { key: 'miles', label: copy.totals.fields.miles, value: formatMiles(totals.milesM) },
    { key: 'hours', label: copy.totals.fields.hours, value: formatHours(totals.seconds) },
    { key: 'safeDays', label: copy.totals.fields.safeDays, value: copy.totals.days(totals.safeDays) },
    {
      key: 'streak',
      label: copy.totals.fields.streak,
      value: copy.totals.days(totals.longestSafeStreak),
    },
    {
      key: 'bestWeek',
      label: copy.totals.fields.bestWeek,
      value:
        totals.bestWeek === null
          ? copy.totals.noneYet
          : copy.totals.bestWeek(
              weekLongLabel(totals.bestWeek.weekStart),
              formatScore(totals.bestWeek.score)
            ),
    },
    {
      key: 'phoneFreeMiles',
      label: copy.totals.fields.phoneFreeMiles,
      value: formatMiles(totals.phoneFreeMilesM),
    },
    {
      key: 'nightMiles',
      label: copy.totals.fields.nightMiles,
      value: formatMiles(totals.nightMilesM),
    },
  ];

  return (
    <Screen scroll testID="totals-screen">
      <TopBar title={copy.totals.title} />
      <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />

      {totals.drives === 0 ? (
        <Card variant="license">
          <EmptyState title={copy.totals.empty.title} body={copy.totals.empty.body} testID="totals-empty" />
        </Card>
      ) : (
        <Card variant="license">
          <Field label={copy.totals.title}>
            <View accessibilityRole="list">
              {record.map((row, index) => (
                <Rule
                  key={row.key}
                  label={`${row.label}, ${row.value}`}
                  first={index === 0}
                  testID={`total-${row.key}`}
                >
                  <Text variant="subhead" style={{ flex: 1 }}>
                    {row.label}
                  </Text>
                  <FieldText face="numeral" variant="body" style={{ textAlign: 'right' }}>
                    {row.value}
                  </FieldText>
                </Rule>
              ))}
            </View>
          </Field>
          <Text variant="footnote" tone="muted">
            {copy.totals.asDriver}
          </Text>
        </Card>
      )}

      <Text variant="footnote" tone="muted">
        {copy.totals.note}
      </Text>
      <Text variant="footnote" tone="subtle">
        {copy.totals.daysNote}
      </Text>

      {/* F9 is a later milestone; the door is shown disabled rather than hidden, so the record
          does not look like something that can never leave the phone. */}
      <View style={{ alignSelf: 'flex-start', marginLeft: -th.space.lg }}>
        <Button
          label={copy.totals.share}
          variant="ghost"
          size="md"
          disabled
          onPress={() => {}}
          accessibilityHint={copy.totals.shareSoon}
        />
      </View>
      <Text variant="footnote" tone="subtle">
        {copy.totals.shareSoon}
      </Text>
    </Screen>
  );
}
