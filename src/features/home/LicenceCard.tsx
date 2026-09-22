import { CONSTANTS } from '@scoring';
import { View } from 'react-native';

import {
  useDataSource,
  useHydrationStatus,
  useLongTermScore,
  useScoreDaily,
  type DayEntry,
  type LongTermScoreView,
} from '@/data/queries';
import { Field, FieldText } from '@/features/trips';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';
import { bandLabel, formatScore, Stamp } from '@/ui/charts';

import { homeCopy } from './copy';

const copy = homeCopy.card;

/** Scored drives before the long-term score exists (§9.6). */
const DRIVES_NEEDED = CONSTANTS.LONG_TERM_MIN_TRIPS;

/** Every cached day: the safe-day count is lifetime, and one row a driving day is small. */
const ALL_DAYS = { from: '0000-01-01', to: '9999-12-31' } as const;

/**
 * A `YYYY-MM-DD` day as the card prints it ("Sep 21") and as it is spoken ("September 21"). The
 * year joins in only when it is not the current one, so a score that is months old says so.
 */
export function formatAsOfDay(day: string, now: number): { printed: string; spoken: string } {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { printed: day, spoken: day };
  const thisYear = new Date(now).getUTCFullYear() === date.getUTCFullYear();
  const opts = (month: 'short' | 'long'): Intl.DateTimeFormatOptions => ({
    month,
    day: 'numeric',
    timeZone: 'UTC',
    ...(thisYear ? null : { year: 'numeric' }),
  });
  return {
    printed: new Intl.DateTimeFormat('en-US', opts('short')).format(date),
    spoken: new Intl.DateTimeFormat('en-US', opts('long')).format(date),
  };
}

/**
 * The learning period (product spec §10: the first drives, while the long-term score is still
 * provisional). Decided only from what is known: never while a restore is owed, since the device
 * does not yet know the driver's history, and a score the server has printed ends it.
 */
export function inLearningPeriod(view: LongTermScoreView): boolean {
  switch (view.state) {
    case 'restoring':
      return false;
    case 'building':
      return true;
    case 'waiting':
      return view.scoredDrives < CONSTANTS.LEARNING_PERIOD_TRIPS;
    case 'score':
      return view.provisional;
  }
}

/** The score field's printed lines and its one spoken label, per state (R9). */
function scoreText(view: LongTermScoreView, now: number) {
  switch (view.state) {
    case 'score': {
      const numeral = view.score === null ? '—' : formatScore(view.score);
      const band = view.band === null ? '' : bandLabel(view.band);
      const day = view.asOfDay === null ? null : formatAsOfDay(view.asOfDay, now);
      const pending = view.pendingDrives > 0 ? copy.pending(view.pendingDrives) : null;
      return {
        numeral,
        band,
        lines: [day ? copy.asOf(day.printed) : null, pending].filter((l): l is string => !!l),
        spoken: [copy.spoken.score(numeral, band, day?.spoken ?? ''), pending]
          .filter(Boolean)
          .join('. '),
      };
    }
    case 'building': {
      const text =
        view.scoredDrives >= DRIVES_NEEDED
          ? copy.buildingTime
          : homeCopy.building(view.scoredDrives, DRIVES_NEEDED);
      const pending = view.pendingDrives > 0 ? copy.pending(view.pendingDrives) : null;
      return {
        numeral: '—',
        band: '',
        lines: [text, pending].filter((l): l is string => !!l),
        spoken: [copy.spoken.building(text), pending].filter(Boolean).join('. '),
      };
    }
    case 'waiting':
      return { numeral: '—', band: '', lines: [copy.waiting], spoken: copy.spoken.waiting };
    case 'restoring':
      return { numeral: '—', band: '', lines: [copy.restoring], spoken: copy.spoken.restoring };
  }
}

function ScoreField({ view }: { view: LongTermScoreView }) {
  const th = useTheme();
  const { now } = useDataSource();
  const text = scoreText(view, now());
  const scored = view.state === 'score';

  return (
    <Field label={copy.score} style={{ flexGrow: 2, flexBasis: 160 }}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={text.spoken}
        testID="licence-score"
        style={{ gap: th.space.xs }}
      >
        {scored ? (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: th.space.sm }}>
            <FieldText face="numeral" variant="display" testID="licence-score-value">
              {text.numeral}
            </FieldText>
            <Text variant="headline">{text.band}</Text>
          </View>
        ) : (
          <FieldText face="numeral" variant="display" tone="subtle">
            {text.numeral}
          </FieldText>
        )}
        {text.lines.map((line) => (
          <Text key={line} variant="footnote" tone="muted">
            {line}
          </Text>
        ))}
      </View>
    </Field>
  );
}

/**
 * Safe days counted from the day rows the server wrote; an unreadable row counts for nothing.
 *
 * The stamp is recomputed from the current state on every read, never carried: a day row keeps the
 * `provisional` it was written with for ever, so "any provisional day" alone would stamp a
 * veteran's count PROVISIONAL for life (review U4 m1). It stamps only while the driver is still in
 * the learning period (the card's own predicate) and a counted day was written provisional.
 */
export function countSafeDays(
  days: readonly DayEntry[],
  learning: boolean
): { count: number; provisional: boolean } {
  const safe = days.filter((d) => !d.unreadable && d.safeDay);
  return {
    count: safe.length,
    provisional: learning && safe.some((d) => d.provisional === true),
  };
}

function SafeDaysField({ restoring, learning }: { restoring: boolean; learning: boolean }) {
  const th = useTheme();
  const days = useScoreDaily(ALL_DAYS);

  let body;
  if (restoring) {
    body = (
      <View accessible accessibilityLabel={copy.spoken.safeDaysRestoring} testID="licence-safe-days">
        <FieldText face="numeral" variant="title1" tone="subtle">
          —
        </FieldText>
        <Text variant="footnote" tone="muted">
          {copy.restoring}
        </Text>
      </View>
    );
  } else if (days.isSuccess) {
    const { count, provisional } = countSafeDays(days.data, learning);
    body = (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm, flexWrap: 'wrap' }}>
        <View accessible accessibilityLabel={copy.spoken.safeDays(count)} testID="licence-safe-days">
          <FieldText face="numeral" variant="title1">
            {String(count)}
          </FieldText>
        </View>
        {provisional ? (
          <Stamp kind="provisional" size="sm" animate={false} testID="safe-days-provisional" />
        ) : null}
      </View>
    );
  } else if (days.error) {
    // The score beside it still stands; only this field says it could not be read.
    body = (
      <FieldText face="numeral" variant="title1" tone="subtle" accessibilityLabel={homeCopy.countError}>
        —
      </FieldText>
    );
  } else {
    body = <Skeleton width={48} height={34} />;
  }

  return (
    <Field label={copy.safeDays} style={{ flexGrow: 1, flexBasis: 96 }}>
      {body}
    </Field>
  );
}

/**
 * The licence card on Home (§7.B B1, direction contract FIRST VIEWPORT): the driver's name, the
 * long-term SCORE as the largest numeral, SAFE DAYS, and a PROVISIONAL stamp while the learning
 * period lasts. The score is the server's (R9) and is always printed with the day it was computed
 * for; STREAK, CLASS and the weekly goal arrive with M5 and are not drawn until they are real.
 */
export function LicenceCard({ name }: { name: string | null | undefined }) {
  const th = useTheme();
  const longTerm = useLongTermScore();
  const hydration = useHydrationStatus();
  const restoring = hydration.state === 'restoring' || hydration.state === 'failed';

  const view = longTerm.data;
  const learning = view ? inLearningPeriod(view) : false;
  const printedName = name?.trim() ? name.trim() : copy.noName;

  return (
    <Card variant="license" testID="licence-card">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: th.space.md,
        }}
      >
        <FieldText
          variant="title2"
          accessibilityRole="header"
          style={{ flexShrink: 1 }}
          testID="licence-name"
        >
          {printedName}
        </FieldText>
        {learning ? <Stamp kind="provisional" size="sm" testID="learning-stamp" /> : null}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
        {view ? (
          <ScoreField view={view} />
        ) : longTerm.error ? (
          <Field label={copy.score} style={{ flexGrow: 2, flexBasis: 160 }}>
            <Banner
              tone="warning"
              message={copy.readError}
              action={{ label: homeCopy.retry, onPress: () => void longTerm.refetch() }}
              testID="licence-score-error"
            />
          </Field>
        ) : (
          <Field label={copy.score} style={{ flexGrow: 2, flexBasis: 160 }}>
            <Skeleton width={96} height={46} />
          </Field>
        )}
        <SafeDaysField restoring={restoring} learning={learning} />
      </View>
    </Card>
  );
}
