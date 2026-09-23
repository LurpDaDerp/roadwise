import { View } from 'react-native';

import { useInsights, useScoreDaily, useTrips, type Insights } from '@/data/queries';
import { Card, EmptyState, Screen, Text } from '@/ui';
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
 *
 * Split in two on purpose. The day cache is keyed by a calendar span that does not exist until
 * the aggregate has resolved its window, and a hook cannot be skipped: asking for `{from:'',
 * to:''}` in the meantime issues a real read, caches it under a nonsense key, and lands its
 * result after the screen has moved on — an un-acted React update that breaks `act` for every
 * later test in the same worker. Mounting the record only once the window is known removes the
 * placeholder read rather than papering over it.
 */
export function TotalsScreen({
  period,
  onPeriodChange,
}: {
  period: InsightsPeriod;
  onPeriodChange: (period: InsightsPeriod) => void;
}) {
  const insightsQuery = useInsights(period);
  const insights = insightsQuery.data;

  if (insightsQuery.isPending) {
    return (
      <Screen scroll>
        <TopBar title={copy.totals.title} />
        {/* The control the driver just used stays under their finger while the page reprints;
            losing it mid-switch reads as the screen having broken. */}
        <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />
        <InsightsSkeleton testID="insights-skeleton" />
      </Screen>
    );
  }

  if (insightsQuery.error || !insights) {
    return (
      <Screen>
        <TopBar title={copy.totals.title} />
        <ReadError onRetry={() => void insightsQuery.refetch()} />
      </Screen>
    );
  }

  return <TotalsRecord insights={insights} period={period} onPeriodChange={onPeriodChange} />;
}

/** The record itself. Mounted only with a window in hand, so both its reads are real ones. */
function TotalsRecord({
  insights,
  period,
  onPeriodChange,
}: {
  insights: Insights;
  period: InsightsPeriod;
  onPeriodChange: (period: InsightsPeriod) => void;
}) {
  const window = windowOf(insights);
  // Every drive the driver made, windowed by `totalsFor`: one cache entry for all four periods.
  const tripsQuery = useTrips({ role: 'driver' });
  const daysQuery = useScoreDaily(window.days);

  // A record is printed once, whole. Painting it from the drives alone would show "Safe days, 0"
  // for a frame and then correct itself, which on a page of records reads as a number that was
  // wrong. `isPending` is false once a read has settled either way, so a failed day cache shows
  // the record with no safe days rather than holding the page.
  if (tripsQuery.isPending || daysQuery.isPending) {
    return (
      <Screen scroll>
        <TopBar title={copy.totals.title} />
        <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />
        <InsightsSkeleton testID="insights-skeleton" />
      </Screen>
    );
  }

  const totals = totalsFor({
    trips: tripsQuery.data ?? [],
    days: daysQuery.data ?? [],
    trend: insights.trend,
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

      {/* No share here (M5 T13): these totals are descriptive and read from this phone, and no F9
          card shows them — a card of the settled streak or class would not be these numbers. */}
    </Screen>
  );
}
