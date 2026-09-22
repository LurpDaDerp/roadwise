import { Ionicons } from '@expo/vector-icons';
import { CONSTANTS, type EventCategory } from '@scoring';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import {
  useDataSource,
  useInsights,
  useLongTermScore,
  useTrips,
  type Insights,
  type LongTermScoreView,
  type YouVsYou,
} from '@/data/queries';
import { homeCopy } from '@/features/home/copy';
import { formatAsOfDay } from '@/features/home/LicenceCard';
import { Card, ListRow, Screen, Text, useTheme } from '@/ui';
import { bandLabel, formatScore, Stamp, TrendLine } from '@/ui/charts';

import { Bars } from './Bars';
import { ChartBlock } from './ChartBlock';
import { InsightsSkeleton, ReadError, TopBar } from './Chrome';
import { insightsCopy as copy } from './copy';
import { Field, FieldText, Rule } from './Field';
import {
  conditionRows,
  highlightsFor,
  MIN_SCORED_TRIPS,
  shareRows,
  shareSummary,
  tableRows,
  toChartTrend,
  trendSummary,
  youVsYouCaption,
  youVsYouRows,
  type YouVsYouRow,
} from './format';
import { PeriodSelector } from './PeriodSelector';
import { periodPhrase, type InsightsPeriod } from './period';
import { categoryHref, howScoringWorksHref, totalsHref } from './routes';

/**
 * The long-term score as one printed field — the server's value (R9, via `useLongTermScore`), with
 * the same qualifiers Home prints: the day it was computed for, the drives still on their way up,
 * and "Restoring…" while the device does not yet know the driver's history.
 */
function ScoreField({ view }: { view: LongTermScoreView }) {
  const th = useTheme();
  const { now } = useDataSource();
  const scored = view.state === 'score' && view.score !== null;
  const day = view.asOfDay === null ? null : formatAsOfDay(view.asOfDay, now());
  const side =
    view.state === 'score' && view.band !== null
      ? bandLabel(view.band)
      : view.state === 'restoring'
        ? homeCopy.card.restoring
        : view.state === 'waiting'
          ? homeCopy.card.waiting
          : copy.score.building;
  const qualifiers = [
    scored && day ? homeCopy.card.asOf(day.printed) : null,
    view.state !== 'restoring' && view.pendingDrives > 0
      ? homeCopy.card.pending(view.pendingDrives)
      : null,
  ].filter((line): line is string => line !== null);

  return (
    <Field label={copy.score.label} testID="long-term-score">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md, flexWrap: 'wrap' }}>
        <FieldText face="numeral" variant="title1" testID="long-term-score-value">
          {scored && view.score !== null ? formatScore(view.score) : copy.score.notYet}
        </FieldText>
        <Text variant="subhead" tone="muted" style={{ flex: 1 }}>
          {side}
        </Text>
        {view.provisional && scored ? (
          <Stamp kind="provisional" size="sm" animate={false} testID="provisional-stamp" />
        ) : null}
      </View>
      {qualifiers.map((line) => (
        <Text key={line} variant="footnote" tone="muted" testID="long-term-score-qualifier">
          {line}
        </Text>
      ))}
      {view.provisional && view.state !== 'restoring' ? (
        <Text variant="footnote" tone="muted">
          {copy.score.provisionalNote(CONSTANTS.LONG_TERM_MIN_TRIPS, CONSTANTS.LONG_TERM_WINDOW_D)}
        </Text>
      ) : null}
    </Field>
  );
}

/** A drawn arrow per direction. It rides beside the words, so meaning never rests on it alone. */
const DELTA_GLYPH: Record<YouVsYouRow['direction'], keyof typeof Ionicons.glyphMap> = {
  better: 'arrow-up',
  worse: 'arrow-down',
  same: 'remove',
};

/**
 * §7.E E1: the current four weeks against the eight before them — the only comparison in the app,
 * and it is with the driver's own earlier self. A local baseline says so and claims nothing more.
 */
function YouVsYouField({
  card,
  source,
}: {
  card: YouVsYou | null;
  source: Insights['baselineSource'];
}) {
  const th = useTheme();

  if (card === null) {
    return (
      <Field label={copy.youVsYou.label} testID="you-vs-you">
        {source === null ? (
          <>
            <Text variant="headline">{copy.youVsYou.building.title}</Text>
            <Text variant="subhead" tone="muted">
              {copy.youVsYou.building.body}
            </Text>
          </>
        ) : (
          <Text variant="subhead" tone="muted">
            {copy.youVsYou.quiet}
          </Text>
        )}
      </Field>
    );
  }

  const rows = youVsYouRows(card);
  return (
    <Field label={copy.youVsYou.label} testID="you-vs-you">
      <Text variant="footnote" tone="subtle">
        {copy.youVsYou.window}
      </Text>
      <View>
        {rows.map((row, index) => (
          <Rule key={row.key} label={row.spoken} first={index === 0} testID={`delta-${row.key}`}>
            <Text variant="subhead" style={{ flex: 1 }}>
              {row.label}
            </Text>
            {/* §7.E E1 asks for per-category arrows. The arrow is drawn *beside* the words, never
                instead of them, and never as the only carrier of the meaning. */}
            <Ionicons
              name={DELTA_GLYPH[row.direction]}
              size={16}
              color={row.direction === 'same' ? th.colors.textSubtle : th.colors.text}
            />
            {/* The movement sits above what it is a movement of: "a drive" printed before the
                number it qualifies reads as "Phone use, a drive, 4 more". */}
            <View style={{ alignItems: 'flex-end', minWidth: 84 }}>
              <FieldText
                face="numeral"
                variant="subhead"
                tone={row.direction === 'same' ? 'muted' : 'default'}
              >
                {row.text}
              </FieldText>
              {row.detail ? (
                <Text variant="caption" tone="subtle">
                  {row.detail}
                </Text>
              ) : null}
            </View>
          </Rule>
        ))}
      </View>
      <Text variant="footnote" tone="muted">
        {youVsYouCaption(source ?? 'local')}
      </Text>
      <Text variant="footnote" tone="subtle">
        {copy.youVsYou.note}
      </Text>
    </Field>
  );
}

/** §7.B B1's progress state, on the screen it explains: what is needed, and no urgency about it. */
function BuildingState({ scored }: { scored: number }) {
  const th = useTheme();
  const done = Math.min(scored, MIN_SCORED_TRIPS);

  return (
    <Card variant="license" testID="not-enough-data">
      <Field label={copy.score.label}>
        <FieldText face="numeral" variant="title1">
          {copy.score.notYet}
        </FieldText>
      </Field>
      <Text variant="headline">{copy.notEnough.building(scored, MIN_SCORED_TRIPS)}</Text>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={copy.notEnough.spokenProgress(scored, MIN_SCORED_TRIPS)}
        accessibilityValue={{ min: 0, max: MIN_SCORED_TRIPS, now: done }}
        testID="building-progress"
        style={{ flexDirection: 'row', gap: th.space.sm }}
      >
        {Array.from({ length: MIN_SCORED_TRIPS }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 10,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: th.colors.borderStrong,
              backgroundColor: i < done ? th.colors.accent : th.colors.surfaceRaised,
            }}
          />
        ))}
      </View>
      <Text variant="subhead" tone="muted">
        {copy.notEnough.body(MIN_SCORED_TRIPS)}
      </Text>
    </Card>
  );
}

/** The doors off E1: E3 and E4. E5 and D4 arrive with their own milestones. */
function Entries({ period }: { period: InsightsPeriod }) {
  const router = useRouter();
  return (
    <Card padded={false} testID="insights-entries">
      <ListRow
        title={copy.entries.totals}
        subtitle={copy.entries.totalsSub}
        onPress={() => router.push(totalsHref(period))}
      />
      <ListRow
        title={copy.entries.how}
        subtitle={copy.entries.howSub}
        onPress={() => router.push(howScoringWorksHref())}
      />
    </Card>
  );
}

/**
 * E1 — the overview (§7.E E1). Long-term progress against the driver's own baseline and nothing
 * else: no ranking, no other drivers, no reward for driving more. The trend is the screen's
 * subject; the score above it is context, not a trophy.
 */
export function InsightsOverviewScreen({
  period,
  onPeriodChange,
  bottomInset = true,
}: {
  period: InsightsPeriod;
  onPeriodChange: (period: InsightsPeriod) => void;
  /** Off inside the tab bar, which sits between this screen and the home indicator and pads itself. */
  bottomInset?: boolean;
}) {
  const router = useRouter();
  const th = useTheme();
  const insightsQuery = useInsights(period);
  // Highlights are a standing record — the run of clean drives from the newest back — so they are
  // read over the driver's own drives rather than over the selected window, and uncapped: a page
  // of 100 would silently print a longer run as exactly "100 drives". `readInsights` already
  // reads the whole table, and E3 shares this cache entry.
  const tripsQuery = useTrips({ role: 'driver' });
  // The ring's number is the server's (R9); `insights.longTerm`, computed on this phone from a
  // different set of trips, is no longer drawn beside it.
  const longTermQuery = useLongTermScore();

  if (insightsQuery.isPending || longTermQuery.isPending) {
    return (
      <Screen scroll bottomInset={bottomInset}>
        <TopBar title={copy.title} />
        {/* The control the driver just used stays under their finger while the page reprints;
            losing it mid-switch reads as the screen having broken. */}
        <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />
        <InsightsSkeleton testID="insights-skeleton" />
      </Screen>
    );
  }

  if (insightsQuery.error || !insightsQuery.data || longTermQuery.error || !longTermQuery.data) {
    return (
      <Screen bottomInset={bottomInset}>
        <TopBar title={copy.title} />
        <ReadError
          onRetry={() => {
            void insightsQuery.refetch();
            void longTermQuery.refetch();
          }}
        />
      </Screen>
    );
  }

  const insights = insightsQuery.data;
  const longTerm = longTermQuery.data;

  if (!insights.enoughData) {
    // The progress state counts this phone's drives, which is honest only while the server agrees
    // there is no score yet. During a restore, or once the server has printed a score this phone's
    // partial history cannot show, the score field says what is known instead.
    const building = longTerm.state === 'building' || longTerm.state === 'waiting';
    return (
      <Screen scroll bottomInset={bottomInset} testID="insights-overview">
        <TopBar title={copy.title} />
        {building ? (
          <BuildingState scored={insights.scoredTripsAllTime} />
        ) : (
          <Card variant="license">
            <ScoreField view={longTerm} />
          </Card>
        )}
        <Entries period={period} />
      </Screen>
    );
  }

  const shares = shareRows(insights.categories);
  const highlights = highlightsFor(tripsQuery.data ?? []);
  const conditions = conditionRows(insights.conditions);
  // §7.0 Empty: a window with nothing in it gets one sentence, not six bars of 0 % and four rows
  // of dashes. The trend, the you-vs-you note and the highlights still have something to say.
  const quiet = insights.totals.scoredTrips === 0;

  return (
    <Screen scroll bottomInset={bottomInset} testID="insights-overview">
      <TopBar title={copy.title} />
      <PeriodSelector value={period} onChange={onPeriodChange} testID="period" />

      <Card variant="license">
        <ScoreField view={longTerm} />
        <Field label={copy.trend.label}>
          <TrendLine
            points={toChartTrend(insights.trend)}
            summaryText={trendSummary(insights.trend, period)}
            toggleLabels={{ table: copy.chart.showTable, chart: copy.chart.showChart }}
            testID="trend"
          />
        </Field>
      </Card>

      <Card>
        <YouVsYouField card={insights.youVsYou} source={insights.baselineSource} />
      </Card>

      {quiet ? (
        <Text variant="subhead" tone="muted" testID="quiet-period">
          {copy.quietPeriod(periodPhrase(period))}
        </Text>
      ) : (
        <Field label={copy.breakdown.label} testID="breakdown">
          <ChartBlock
            interactive
            summaryText={shareSummary(insights.categories, period)}
            table={{
              caption: copy.breakdown.caption,
              columns: [
                { title: copy.breakdown.columns.category },
                { title: copy.breakdown.columns.share, numeric: true },
                { title: copy.breakdown.columns.points, numeric: true },
              ],
              rows: tableRows(shares),
            }}
            testID="breakdown-chart"
          >
            <Bars
              rows={shares}
              pressHint={copy.breakdown.hint}
              onPress={(key) => router.push(categoryHref(key as EventCategory, period))}
              testID="breakdown-bars"
            />
          </ChartBlock>
        </Field>
      )}

      {/* Not period-scoped: a run of clean drives is a standing record, and stays whatever
          window is open. */}
      <Field label={copy.highlights.label} testID="highlights">
        {highlights.length === 0 ? (
          <Text variant="subhead" tone="muted">
            {copy.highlights.none}
          </Text>
        ) : (
          <View accessibilityRole="list">
            {highlights.map((highlight, index) => (
              <Rule key={highlight.category} label={highlight.text} first={index === 0}>
                {/* A drawn check, not a colour: the meaning is in the glyph and the sentence. */}
                <Ionicons name="checkmark-circle-outline" size={22} color={th.colors.success} />
                <Text variant="body" style={{ flex: 1 }}>
                  {highlight.text}
                </Text>
              </Rule>
            ))}
          </View>
        )}
      </Field>

      {quiet ? null : (
        <Field label={copy.conditions.label} testID="conditions">
          <View accessibilityRole="list">
            {conditions.map((row, index) => (
              <Rule
                key={row.key}
                label={row.spoken}
                first={index === 0}
                testID={`condition-${row.key}`}
              >
                <Text variant="subhead" style={{ width: '28%' }}>
                  {row.label}
                </Text>
                <FieldText face="numeral" variant="subhead" style={{ minWidth: 40 }}>
                  {row.score}
                </FieldText>
                <Text variant="footnote" tone="muted" style={{ flex: 1, textAlign: 'right' }}>
                  {row.detail}
                </Text>
              </Rule>
            ))}
          </View>
          <Text variant="footnote" tone="muted">
            {copy.conditions.note}
          </Text>
        </Field>
      )}

      <Entries period={period} />
    </Screen>
  );
}
