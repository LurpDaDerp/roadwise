import { CONSTANTS } from '@scoring';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useTrips, type TripSummary } from '@/data/queries';
import {
  conditionsLabel,
  dateLine,
  Field,
  FieldText,
  RoleChips,
  routeLine,
  tripSummaryHref,
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

  return (
    <Card testID="last-trip">
      <Field label={copy.lastDrive}>
        {/* Bled to the card's edges: the row's own padding puts its content back on the card's
            content edge, and the pressed wash covers the whole rule rather than a floating inset. */}
        <View style={{ marginHorizontal: -th.space.lg }}>
          <ListRow
            title={routeLine(trip)}
            subtitle={dateLine(trip)}
            detail={<Splits trip={trip} />}
            leading={<ScoreBlock score={score} />}
            onPress={() => router.push(tripSummaryHref(trip.clientTripId))}
            accessibilityLabel={[
              copy.lastDrive,
              routeLine(trip),
              dateLine(trip),
              ...splitsOf(trip),
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
