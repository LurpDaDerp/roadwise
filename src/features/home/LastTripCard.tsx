import { Ionicons } from '@expo/vector-icons';
import { CONSTANTS } from '@scoring';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useTrips, type TripSummary } from '@/data/queries';
import {
  conditionsLabel,
  dateLine,
  Field,
  FieldText,
  highlightsFor,
  RoleChips,
  routeLine,
  spokenRoute,
  tripSummaryHref,
  type Highlight,
} from '@/features/trips';
import { formatDistanceMi, formatDuration } from '@/lib/format';
import { Banner, Card, EmptyState, ListRow, Skeleton, Text, useTheme } from '@/ui';
import { bandLabel, formatScore } from '@/ui/charts';

import { homeCopy as copy } from './copy';

/** Scored drives before the long-term score exists (§9.6); the card counts up to it. */
export const DRIVES_TO_BUILD = CONSTANTS.LONG_TERM_MIN_TRIPS;

/** The licence's biggest field, or an honest dash: this is what `ListRow`'s label would silence. */
function ScoreBlock({ score }: { score: { numeral: string; band: string } | null }) {
  return (
    <View style={{ alignItems: 'center', minWidth: 64 }}>
      <Text variant="display" tone={score ? undefined : 'subtle'}>
        {score ? score.numeral : '—'}
      </Text>
      <Text variant="caption" tone="muted">
        {score ? score.band : copy.notScored}
      </Text>
    </View>
  );
}

/** Time, distance, conditions — the three splits the direction contract prints on this row. */
function splitsOf(trip: TripSummary): string[] {
  return [formatDuration(trip.durationS), formatDistanceMi(trip.distanceM), conditionsLabel(trip)];
}

function Splits({ trip }: { trip: TripSummary }) {
  const th = useTheme();
  const [duration, distance, conditions] = splitsOf(trip);
  return (
    <View style={{ flexDirection: 'row', gap: th.space.md }}>
      <FieldText face="numeral" variant="footnote" tone="muted">
        {duration}
      </FieldText>
      <FieldText face="numeral" variant="footnote" tone="muted">
        {distance}
      </FieldText>
      <FieldText variant="footnote" tone="muted">
        {conditions}
      </FieldText>
    </View>
  );
}

/**
 * §7.B B1 item 5's top highlight: the first of the same three D1 prints, which is a positive
 * whenever the drive earned one and the costly category otherwise. The Home row reads no
 * timeline, so a costly category is named without its episode count — the documented degradation
 * of `highlightsFor`, and the count is one tap away on the card back.
 */
const topHighlightOf = (trip: TripSummary): Highlight | undefined => highlightsFor(trip, [])[0];

function TopHighlight({ highlight }: { highlight: Highlight }) {
  const th = useTheme();
  const positive = highlight.kind === 'positive';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }}>
      <Ionicons
        name={positive ? 'checkmark-circle-outline' : 'remove-circle-outline'}
        size={14}
        color={positive ? th.colors.success : th.colors.danger}
      />
      <Text variant="footnote" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
        {highlight.text}
      </Text>
    </View>
  );
}

/**
 * The RECORD row on Home (§7.B B1 item 5): the last drive as one ruled row — the score numeral
 * with its band word, the route and date, the three splits — that opens the card back. Until
 * three drives are scored the row says how far the score has got; an unclassified drive asks its
 * question here rather than waiting for the summary to be opened.
 */
export function LastTripCard() {
  const router = useRouter();
  const th = useTheme();
  const last = useTrips({ limit: 1 });
  const scored = useTrips({ scoredOnly: true, limit: DRIVES_TO_BUILD });

  if (last.isPending) {
    return (
      <Card testID="last-trip-loading">
        <Skeleton width={96} height={12} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg }}>
          <Skeleton width={64} height={46} />
          <View style={{ flex: 1, gap: th.space.sm }}>
            <Skeleton width="80%" height={20} />
            <Skeleton width="50%" height={16} />
          </View>
        </View>
      </Card>
    );
  }

  if (last.error) {
    return (
      <Card testID="last-trip-error">
        <Banner
          tone="danger"
          message={copy.error}
          action={{ label: copy.retry, onPress: () => void last.refetch() }}
        />
      </Card>
    );
  }

  const trip = last.data?.[0];
  if (!trip) {
    return (
      <Card testID="last-trip-empty">
        <EmptyState title={copy.empty.title} body={copy.empty.body} />
      </Card>
    );
  }

  const score =
    trip.scored && trip.score !== null && trip.band !== null
      ? { numeral: formatScore(trip.score), band: bandLabel(trip.band) }
      : null;

  // Counted only once the count is real: a second query settling a frame later must not print
  // "0 of 3 drives" under three scored drives, and a count that cannot be read says so rather
  // than something false.
  const scoredCount = Math.min(scored.data?.length ?? 0, DRIVES_TO_BUILD);
  const building = scored.isSuccess && scoredCount < DRIVES_TO_BUILD;
  const top = topHighlightOf(trip);

  return (
    <Card testID="last-trip">
      <Field label={copy.lastDrive}>
        {/* Bled to the card's edges: the row's own padding puts its content back on the card's
            content edge, and the pressed wash covers the whole rule rather than a floating inset. */}
        <View style={{ marginHorizontal: -th.space.lg }}>
          <ListRow
            title={routeLine(trip)}
            subtitle={dateLine(trip)}
            detail={
              <>
                <Splits trip={trip} />
                {top ? <TopHighlight highlight={top} /> : null}
              </>
            }
            leading={<ScoreBlock score={score} />}
            onPress={() => router.push(tripSummaryHref(trip.clientTripId))}
            accessibilityLabel={[
              copy.lastDrive,
              // Spoken, not printed: the arrow in the route line reads as "right arrow" or is
              // dropped altogether (Task 6 review, M-7).
              spokenRoute(trip),
              dateLine(trip),
              ...splitsOf(trip),
              ...(top ? [top.text] : []),
              score ? `${score.numeral}, ${score.band}` : copy.notScored,
            ].join(', ')}
            accessibilityHint={copy.open}
            testID="last-trip-row"
          />
        </View>
      </Field>

      {building ? (
        <Text variant="footnote" tone="muted" testID="building-score">
          {copy.building(scoredCount, DRIVES_TO_BUILD)}
        </Text>
      ) : null}

      {scored.error ? (
        <Banner
          tone="warning"
          message={copy.countError}
          action={{ label: copy.retry, onPress: () => void scored.refetch() }}
          testID="count-error"
        />
      ) : null}

      {trip.role === 'unknown' ? (
        <RoleChips clientTripId={trip.clientTripId} testID="home-role-chips" />
      ) : null}
    </Card>
  );
}
