import { CONSTANTS, type EventCategory } from '@scoring';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import type { Tip } from '@/content/tips';
import { useInsights, useTrips, type Insights } from '@/data/queries';
import { Button, Card, EmptyState, ListRow, Screen, Text, useTheme } from '@/ui';
import { Stamp } from '@/ui/charts';

import { Bars } from './Bars';
import { ChartBlock } from './ChartBlock';
import { InsightsSkeleton, ReadError, TopBar } from './Chrome';
import { insightsCopy as copy } from './copy';
import { Field, FieldText, Rule } from './Field';
import {
  categoryFigures,
  categoryLabel,
  categoryPhrase,
  describeRows,
  exampleTripsFor,
  inWindow,
  notMeasuredReason,
  tableRows,
  timeOfDayRows,
  timeOfDaySummary,
  tipsFor,
  weeklyRateColumns,
  weeklyRateSummary,
  type NotMeasured,
} from './format';
import { PeriodSelector } from './PeriodSelector';
import { periodPhrase, type InsightsPeriod } from './period';
import { insightsHref, tripSummaryHref } from './routes';
import { useCameraMode } from './useCameraMode';

/** The three exposure-normalised figures §7.E E2 leads with, as printed fields. */
function RatesField({
  figures,
  period,
}: {
  figures: ReturnType<typeof categoryFigures>;
  period: InsightsPeriod;
}) {
  // Each row speaks its own unit: "26.7" alone is not a number a reader can act on.
  const rows = [
    {
      key: 'total',
      label: copy.category.rates.total,
      value: figures.total,
      spoken: copy.category.rates.spokenRate(copy.category.rates.total, figures.total),
    },
    {
      key: 'per100Mi',
      label: copy.category.rates.per100Mi,
      value: figures.per100Mi,
      spoken: copy.category.rates.spokenRate(copy.category.rates.per100Mi, figures.per100Mi),
    },
    {
      key: 'perHour',
      label: copy.category.rates.perHour,
      value: figures.perHour,
      spoken: copy.category.rates.spokenRate(copy.category.rates.perHour, figures.perHour),
    },
    {
      key: 'drives',
      label: copy.category.rates.drives,
      value: figures.drives,
      spoken: `${copy.category.rates.drives}, ${figures.drives}`,
    },
  ];

  return (
    <Field label={copy.category.rates.label(periodPhrase(period))} testID="rates">
      <View accessibilityRole="list">
        {rows.map((row, index) => (
          <Rule key={row.key} label={row.spoken} first={index === 0}>
            <Text variant="subhead" style={{ flex: 1 }}>
              {row.label}
            </Text>
            <FieldText face="numeral" variant="body" testID={`rate-${row.key}`}>
              {row.value}
            </FieldText>
          </Rule>
        ))}
      </View>
    </Field>
  );
}

function Tips({ tips, title }: { tips: readonly Tip[]; title: string }) {
  const th = useTheme();
  return (
    <Field label={title} testID="tips">
      <View style={{ gap: th.space.lg }}>
        {tips.map((tip) => (
          <View key={tip.id} style={{ gap: th.space.xs }} testID={`tip-${tip.id}`}>
            <Text variant="headline">{tip.title}</Text>
            <Text variant="subhead" tone="muted">
              {tip.body}
            </Text>
          </View>
        ))}
      </View>
    </Field>
  );
}

/**
 * §7.E E2: the camera category without camera mode. An explainer and the way to turn it on — not
 * a nag, and not a claim that anything is missing from the record. The privacy line is repeated
 * here because this is where a driver decides, and §13 says the terms are stated at the decision.
 */
function CameraExplainer() {
  const th = useTheme();
  return (
    <Card testID="camera-explainer">
      <Text variant="title3" accessibilityRole="header">
        {copy.category.camera.title}
      </Text>
      <Text variant="subhead" tone="muted">
        {copy.category.camera.body}
      </Text>
      <Text variant="footnote" tone="muted">
        {copy.category.camera.privacy}
      </Text>
      <View style={{ alignSelf: 'flex-start', marginLeft: -th.space.lg }}>
        <Button
          label={copy.category.camera.settings}
          variant="ghost"
          size="md"
          disabled
          onPress={() => {}}
          accessibilityHint={copy.category.camera.settingsSoon}
        />
      </View>
      <Text variant="footnote" tone="subtle">
        {copy.category.camera.settingsSoon}
      </Text>
    </Card>
  );
}

/**
 * The window held nothing this category could be read from. Said plainly, and never as a failure
 * or as a reason to drive more — the period selector sits right above it, and widening it is the
 * move. The tips stay: advice about a habit is useful whether or not this window saw it.
 */

function NotMeasuredCard({ reason, period }: { reason: NotMeasured; period: InsightsPeriod }) {
  const said = copy.category.notMeasured[reason](periodPhrase(period));
  // `all` is already the widest window there is; offering to widen it would name a move the
  // period selector cannot make.
  const body = period === 'all' ? said : `${said} ${copy.category.notMeasured.widen}`;

  return (
    <Card testID="category-not-measured">
      <Text variant="title3" accessibilityRole="header">
        {copy.category.notMeasured.title}
      </Text>
      <Text variant="subhead" tone="muted">
        {body}
      </Text>
    </Card>
  );
}

/**
 * Nothing lost to this behaviour in the window: the celebration §7.E E2 asks for. The stamp is
 * this screen's one moving thing — it lands once, on arrival, and is simply there under reduce
 * motion.
 */
function CleanField({ category, period }: { category: EventCategory; period: InsightsPeriod }) {
  const th = useTheme();
  return (
    <Card variant="license" testID="category-clean">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg, flexWrap: 'wrap' }}>
        <Stamp kind="safeDay" label={copy.category.clean.stamp} />
        <Text variant="title3" style={{ flex: 1 }} accessibilityRole="header">
          {copy.category.clean.title(categoryPhrase(category), periodPhrase(period))}
        </Text>
      </View>
    </Card>
  );
}

/**
 * E2 — one behaviour, end to end (§7.E E2). Rates normalised by how far and how long the driver
 * actually drove, the same rate week by week and by time of day, two tips, and the drives it
 * happened on. Severity bands, road type and the private map of where it happens need events
 * queried by date range, which the M1 repos do not offer yet; the screen says so rather than
 * quietly leaving them out.
 */
export function CategoryScreen({
  category,
  period,
  onPeriodChange,
}: {
  category: EventCategory | null;
  period: InsightsPeriod;
  onPeriodChange: (period: InsightsPeriod) => void;
}) {
  const router = useRouter();
  const insightsQuery = useInsights(period);
  const cameraQuery = useCameraMode();
  // Every scored drive, windowed below rather than in the filter: one cache entry serves all four
  // periods, so switching the selector re-reads the aggregate and not the whole trips table.
  const tripsQuery = useTrips({ role: 'driver', scoredOnly: true });

  if (category === null) {
    return (
      <Screen>
        <TopBar title={copy.title} />
        {/* §7.0: never a dead end. A cold open of a stale link has no Back to fall back on, so
            the way to the overview has to be on the screen itself. */}
        <EmptyState
          title={copy.category.notFound.title}
          body={copy.category.notFound.body}
          action={{
            label: copy.category.notFound.action,
            onPress: () => router.replace(insightsHref(period)),
          }}
          testID="category-not-found"
        />
      </Screen>
    );
  }

  const label = categoryLabel(category);

  // All three reads, not just the aggregate: `notMeasuredReason` is computed from the drive list,
  // so painting before it lands would flash "No scored drives" over a window that has plenty.
  if (insightsQuery.isPending || tripsQuery.isPending || cameraQuery.isPending) {
    return (
      <Screen scroll>
        <TopBar title={label} />
        {/* The control the driver just used stays under their finger while the page reprints;
            losing it mid-switch reads as the screen having broken. */}
        <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />
        <InsightsSkeleton testID="insights-skeleton" />
      </Screen>
    );
  }

  if (insightsQuery.error || !insightsQuery.data) {
    return (
      <Screen>
        <TopBar title={label} />
        <ReadError onRetry={() => void insightsQuery.refetch()} />
      </Screen>
    );
  }

  const insights: Insights = insightsQuery.data;
  const trips = inWindow(tripsQuery.data ?? [], insights);
  const stage =
    insights.scoredTripsAllTime >= CONSTANTS.LEARNING_PERIOD_TRIPS ? 'experienced' : 'new';
  const tips = tipsFor(category, stage);
  const figures = categoryFigures(insights.categories, category, insights.totals.scoredTrips);

  // Not while the setting is still being read: `undefined` is "not known yet", not "off".
  const cameraOff = category === 'focus' && !cameraQuery.isPending && cameraQuery.data !== true;
  // What this window could actually see. A category the app did not observe has not been kept
  // clean — it has not been looked at — so it never earns the stamp.
  //
  // Points that *were* measured outrank the notice, always. `LIMIT_KNOWN_PCT` gates whether a
  // clean speeding record can be claimed; it never gates the points themselves, which the
  // scorer takes from whatever stretch of road was mapped. So a window that cost points has
  // plainly been looked at, whatever the coverage of the rest of the drive says — and the notice
  // would contradict both E1's breakdown and the score the driver is carrying.
  const reason = notMeasuredReason(category, {
    scoredTrips: insights.totals.scoredTrips,
    trips,
  });
  const notMeasured = figures.deduction > 0 ? null : reason;
  const weeks = weeklyRateColumns(insights.trend, category);
  const buckets = timeOfDayRows(insights.timeOfDay, category);
  const examples = exampleTripsFor(trips, category);

  return (
    <Screen scroll testID="category-screen">
      <TopBar title={label} />
      <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />

      {cameraOff ? <CameraExplainer /> : null}

      {notMeasured !== null ? (
        <>
          {/* With camera mode off the explainer above has already said this, in full. */}
          {cameraOff && notMeasured === 'noCamera' ? null : (
            <NotMeasuredCard reason={notMeasured} period={period} />
          )}
          <Tips tips={tips} title={copy.category.tips.label} />
        </>
      ) : figures.clean ? (
        <>
          <CleanField category={category} period={period} />
          <RatesField figures={figures} period={period} />
          <Tips tips={tips} title={copy.category.clean.keepItUp} />
        </>
      ) : (
        <>
          <RatesField figures={figures} period={period} />

          <Field label={copy.category.trend.label} testID="category-trend">
            <ChartBlock
              label={describeRows(copy.category.trend.caption(label), weeks)}
              summaryText={weeklyRateSummary(weeks, period)}
              table={{
                caption: copy.category.trend.caption(label),
                columns: [
                  { title: copy.category.trend.columns.week },
                  { title: copy.category.trend.columns.rate, numeric: true },
                  { title: copy.category.trend.columns.points, numeric: true },
                ],
                rows: tableRows(weeks),
              }}
              testID="category-trend-chart"
            >
              <Bars rows={weeks} testID="category-trend-bars" />
            </ChartBlock>
            {insights.trend.length > weeks.length ? (
              <Text variant="footnote" tone="subtle">
                {copy.category.trend.capped(weeks.length)}
              </Text>
            ) : null}
          </Field>

          <Field label={copy.category.timeOfDay.label} testID="time-of-day">
            <ChartBlock
              label={describeRows(copy.category.timeOfDay.caption, buckets)}
              summaryText={timeOfDaySummary(buckets, category, period)}
              table={{
                caption: copy.category.timeOfDay.caption,
                columns: [
                  { title: copy.category.timeOfDay.columns.time },
                  { title: copy.category.timeOfDay.columns.rate, numeric: true },
                  { title: copy.category.timeOfDay.columns.drives, numeric: true },
                ],
                rows: tableRows(buckets),
              }}
              testID="time-of-day-chart"
            >
              <Bars rows={buckets} testID="time-of-day-bars" />
            </ChartBlock>
            <Text variant="footnote" tone="subtle">
              {copy.category.timeOfDay.bounds}
            </Text>
          </Field>

          <Tips tips={tips} title={copy.category.tips.label} />

          {examples.length > 0 ? (
            <Field label={copy.category.examples.label} testID="examples">
              <Card padded={false}>
                {examples.map((example) => (
                  <ListRow
                    key={example.clientTripId}
                    title={example.title}
                    subtitle={`${example.cost} · ${example.detail}`}
                    onPress={() => router.push(tripSummaryHref(example.clientTripId))}
                    testID={`example-${example.clientTripId}`}
                  />
                ))}
              </Card>
            </Field>
          ) : null}

          <Text variant="footnote" tone="subtle">
            {copy.category.later}
          </Text>
        </>
      )}
    </Screen>
  );
}
