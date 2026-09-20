import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { useScoreDaily, useTrips, type DayEntry, type TripSummary } from '@/data/queries';
import { formatDistanceMi, formatDuration } from '@/lib/format';
import { Banner, Button, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';
import { bandLabel, formatScore, Stamp } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { groupTripsByDay, historyItems, type HistoryItem } from './detail';
import { FieldText } from './Field';
import { conditionsLabel, formatTripDate, formatTimeSpan, spokenRoute, routeLine } from './format';
import { ICON, TIGHT, TOUCH } from './layout';
import { tripSummaryHref } from './routes';
import { TripTopBar } from './TopBar';
import { hasFilters, NO_FILTERS, toTripsFilter, TripFilterBar, type HistoryFilters } from './TripFilters';

/** Drives fetched per page. A page is a SQLite read, so this is generous rather than careful. */
export const PAGE_SIZE = 30;

const ROLE_ICON: Record<TripSummary['role'], keyof typeof Ionicons.glyphMap> = {
  driver: 'car-outline',
  passenger: 'person-outline',
  other: 'bus-outline',
  unknown: 'help-circle-outline',
};

function DayHeader({ trip, day, testID }: { trip: TripSummary; day: DayEntry | null; testID?: string }) {
  const th = useTheme();
  const stamp = day?.safeDay === true ? 'safeDay' : day?.goodDay === true ? 'good' : null;
  const date = formatTripDate(trip.startedAt, trip.tz);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: th.space.md,
        paddingTop: th.space.lg,
        paddingBottom: th.space.xs,
      }}
    >
      <Text variant="headline" accessibilityRole="header">
        {date}
      </Text>
      {stamp === 'safeDay' ? (
        <Stamp kind="safeDay" size="sm" animate={false} testID="stamp-safe-day" />
      ) : stamp === 'good' ? (
        <Stamp kind="safeDay" size="sm" label={copy.history.goodDay} animate={false} />
      ) : null}
    </View>
  );
}

/** One drive on the record: the score, the route, and what kind of trip it was. */
function HistoryRow({ trip, onPress }: { trip: TripSummary; onPress: () => void }) {
  const th = useTheme();
  const scored = trip.scored && trip.score !== null && trip.band !== null;
  const conditions = conditionsLabel(trip);
  const role = copy.history.roles[trip.role];
  const spoken = [
    formatTimeSpan(trip.startedAt, trip.endedAt, trip.tz),
    spokenRoute(trip),
    scored && trip.band !== null && trip.score !== null
      ? `${formatScore(trip.score)}, ${bandLabel(trip.band)}`
      : copy.score.notScored,
    formatDistanceMi(trip.distanceM),
    role,
    conditions,
  ].join(', ');

  return (
    <Pressable
      testID={`history-${trip.clientTripId}`}
      accessible
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={copy.history.hint}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        minHeight: TOUCH + th.space.md,
        paddingVertical: th.space.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: th.colors.divider,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <View style={{ minWidth: 56, alignItems: 'center' }}>
        {scored && trip.score !== null && trip.band !== null ? (
          <>
            <FieldText face="numeral" variant="title1">
              {formatScore(trip.score)}
            </FieldText>
            <Text variant="caption" tone="muted">
              {bandLabel(trip.band)}
            </Text>
          </>
        ) : (
          <>
            <FieldText face="numeral" variant="title1" tone="subtle">
              {'—'}
            </FieldText>
            <Text variant="caption" tone="muted">
              {copy.score.notScored}
            </Text>
          </>
        )}
      </View>

      <View style={{ flex: 1, gap: TIGHT }}>
        <Text variant="body" numberOfLines={2}>
          {routeLine(trip)}
        </Text>
        <Text variant="footnote" tone="muted">
          {formatTimeSpan(trip.startedAt, trip.endedAt, trip.tz)}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: th.space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }}>
            <Ionicons name={ROLE_ICON[trip.role]} size={ICON.xs} color={th.colors.textSubtle} />
            <Text variant="caption" tone="subtle">
              {copy.history.roles[trip.role]}
            </Text>
          </View>
          <FieldText face="numeral" variant="caption" tone="subtle">
            {formatDistanceMi(trip.distanceM)}
          </FieldText>
          <FieldText face="numeral" variant="caption" tone="subtle">
            {formatDuration(trip.durationS)}
          </FieldText>
          <Text variant="caption" tone="subtle">
            {conditions}
          </Text>
        </View>
      </View>

      <Ionicons name="chevron-forward" size={ICON.md} color={th.colors.textSubtle} />
    </Pressable>
  );
}

/**
 * D4 — the history (§7.D D4): every drive on this phone, grouped by the day it was driven.
 *
 * Grouping is by the **trip's own** local day, which is the date the server filed its day
 * evaluation under, so the SAFE DAY stamp on a header is that day's actual verdict from the
 * cache and not a guess made here.
 *
 * Paging reads more rows from SQLite rather than from the network — this list is entirely local,
 * so "older drives" is instant and works in a tunnel. `getItemLayout` is deliberately absent:
 * row heights reflow with Dynamic Type up to 200 % (§14), and a fixed height would be a lie at
 * every size but one.
 *
 * The retention notice closes the list (§7.D D4) rather than floating above it: it is the answer
 * to "is that everything?", which is a question only asked at the bottom.
 */
export function TripHistoryScreen() {
  const router = useRouter();
  const th = useTheme();
  const [filters, setFilters] = useState<HistoryFilters>(NO_FILTERS);
  const [limit, setLimit] = useState(PAGE_SIZE);

  // The filters are the query; the page is not. `readTrips` reads the whole table and applies
  // `limit` in TypeScript afterwards, so putting the page size in the key would buy nothing at
  // the database and cost the list a blink through "loading" and "no drives" on its way to
  // *more* drives. Paging is therefore a local slice of one cached, filtered read — still from
  // SQLite, still instant in a tunnel, and `more` is exact rather than a guess.
  const tripsQuery = useTrips(toTripsFilter(filters));
  const all = useMemo(() => tripsQuery.data ?? [], [tripsQuery.data]);
  const trips = useMemo(() => all.slice(0, limit), [all, limit]);
  const groups = useMemo(() => groupTripsByDay(trips), [trips]);
  const items = useMemo(() => historyItems(groups), [groups]);

  // One read for every day on screen; `score_daily_cache` is keyed by the same local dates.
  const days = groups.map((group) => group.day);
  const range = {
    from: days[days.length - 1] ?? '9999-12-31',
    to: days[0] ?? '9999-12-31',
  };
  const daysQuery = useScoreDaily(range);
  const dayByKey = useMemo(() => {
    const map = new Map<string, DayEntry>();
    for (const entry of daysQuery.data ?? []) map.set(entry.day, entry);
    return map;
  }, [daysQuery.data]);

  const filtered = hasFilters(filters);
  const more = all.length > limit;

  const renderItem = ({ item }: { item: HistoryItem }) => {
    if (item.kind === 'day') {
      const group = groups.find((entry) => entry.day === item.day);
      const first = group?.trips[0];
      if (!first) return null;
      return (
        <DayHeader trip={first} day={dayByKey.get(item.day) ?? null} testID={`day-${item.day}`} />
      );
    }
    return (
      <HistoryRow
        trip={item.trip}
        onPress={() => router.push(tripSummaryHref(item.trip.clientTripId))}
      />
    );
  };

  if (tripsQuery.isPending) {
    return (
      <Screen>
        <TripTopBar title={copy.history.title} onBack={null} />
        <View accessibilityLabel={copy.history.loading} accessibilityRole="progressbar" accessible>
          <Skeleton width="40%" height={20} />
          <Skeleton width="100%" height={72} />
          <Skeleton width="100%" height={72} />
          <Skeleton width="100%" height={72} />
        </View>
      </Screen>
    );
  }

  if (tripsQuery.error) {
    return (
      <Screen>
        <TripTopBar title={copy.history.title} onBack={null} />
        <Banner
          tone="danger"
          message={copy.history.error}
          action={{ label: copy.history.retry, onPress: () => void tripsQuery.refetch() }}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="trip-history">
      <TripTopBar title={copy.history.title} onBack={null} />
      <TripFilterBar filters={filters} onChange={setFilters} testID="history-filters" />

      {items.length === 0 ? (
        // No action here: the filter bar above already carries "Clear filters" whenever a
        // filter is on, and two controls with the same name in one view is one too many.
        <EmptyState
          title={filtered ? copy.history.emptyFilteredTitle : copy.history.emptyTitle}
          body={filtered ? copy.history.emptyFilteredBody : copy.history.emptyBody}
          testID="history-empty"
        />
      ) : (
        <FlatList
          testID="history-list"
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: th.space.xl }}
          ListFooterComponent={
            <View style={{ gap: th.space.md, paddingTop: th.space.lg }}>
              {more ? (
                <Button
                  label={copy.history.more}
                  variant="secondary"
                  size="md"
                  onPress={() => setLimit((value) => value + PAGE_SIZE)}
                  testID="load-more"
                />
              ) : null}
              <Text variant="footnote" tone="subtle" testID="retention-notice">
                {copy.history.retention}
              </Text>
            </View>
          }
        />
      )}
    </Screen>
  );
}
