import { Ionicons } from '@expo/vector-icons';
import { CONSTANTS } from '@scoring';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useTrips } from '@/data/queries';
import { Field, FieldText, RoleChips, dateLine, routeLine, tripSummaryHref } from '@/features/trips';
import { formatDistanceMi, formatDuration } from '@/lib/format';
import { Banner, Card, EmptyState, Skeleton, Text, useTheme } from '@/ui';
import { bandLabel, formatScore } from '@/ui/charts';

import { homeCopy as copy } from './copy';

/** Scored drives before the long-term score exists (§9.6); the card counts up to it. */
export const DRIVES_TO_BUILD = CONSTANTS.LONG_TERM_MIN_TRIPS;

/**
 * The RECORD row on Home (§7.B B1 item 5): the last drive as one ruled row — the score
 * numeral with its band word, the route and date, the two splits — that opens the card back.
 * Until three drives are scored the row says how far the score has got; an unclassified drive
 * asks its question here rather than waiting for the summary to be opened.
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

  const scoredCount = Math.min(scored.data?.length ?? 0, DRIVES_TO_BUILD);
  const building = scoredCount < DRIVES_TO_BUILD;
  const score = trip.scored && trip.score !== null && trip.band !== null
    ? { numeral: formatScore(trip.score), band: bandLabel(trip.band) }
    : null;
  const spoken = [
    copy.lastDrive,
    routeLine(trip),
    dateLine(trip),
    score ? `${score.numeral}, ${score.band}` : copy.notScored,
  ].join(', ');

  return (
    <Card testID="last-trip">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint={copy.open}
        onPress={() => router.push(tripSummaryHref(trip.clientTripId))}
        style={({ pressed }) => ({
          gap: th.space.sm,
          margin: -th.space.sm,
          padding: th.space.sm,
          borderRadius: th.radius.sm,
          backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
        })}
      >
        <Field label={copy.lastDrive}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg }}>
            <View style={{ alignItems: 'center', minWidth: 64 }}>
              {score ? (
                <>
                  <Text variant="display">{score.numeral}</Text>
                  <Text variant="caption" tone="muted">
                    {score.band}
                  </Text>
                </>
              ) : (
                <>
                  <Text variant="display" tone="subtle">
                    {'—'}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {copy.notScored}
                  </Text>
                </>
              )}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="headline" numberOfLines={2}>
                {routeLine(trip)}
              </Text>
              <Text variant="footnote" tone="muted">
                {dateLine(trip)}
              </Text>
              <View style={{ flexDirection: 'row', gap: th.space.md }}>
                <FieldText face="numeral" variant="footnote" tone="muted">
                  {formatDuration(trip.durationS)}
                </FieldText>
                <FieldText face="numeral" variant="footnote" tone="muted">
                  {formatDistanceMi(trip.distanceM)}
                </FieldText>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={th.colors.textSubtle} />
          </View>
        </Field>
      </Pressable>

      {building ? (
        <Text variant="footnote" tone="muted" testID="building-score">
          {copy.building(scoredCount, DRIVES_TO_BUILD)}
        </Text>
      ) : null}

      {trip.role === 'unknown' ? (
        <RoleChips clientTripId={trip.clientTripId} testID="home-role-chips" />
      ) : null}
    </Card>
  );
}
