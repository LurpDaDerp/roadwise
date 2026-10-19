import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { Chip, EmptyState, formatPointsValue, Text, useTheme } from '@/ui';

import { useFriendsBoard, type FriendsMetric } from './api';
import {
  BoardRow,
  ListSkeleton,
  LoadFailed,
  RefreshFailedNote,
  RowSeparator,
  usePullRefresh,
} from './components';
import { leaguesCopy } from './copy';
import { rankFriendsBoard, ratingText, type RankedFriendRow } from './model';
import { FRIENDS_ADD_HREF, profileHref } from './routes';

const copy = leaguesCopy;

/** Friends: you and your friends, by week points or Safety Rating. */
export function FriendsBoard() {
  const t = useTheme();
  const router = useRouter();
  const units = useUnits();
  const [metric, setMetric] = useState<FriendsMetric>('week');
  const q = useFriendsBoard(metric);
  const pull = usePullRefresh(q.refetch);
  // switching the metric keeps the last board on screen until the new one lands; with two metrics,
  // a held (placeholder) board is always the other one, so read it with that metric
  const stale = q.isPlaceholderData;
  const shownMetric: FriendsMetric = stale ? (metric === 'week' ? 'rating' : 'week') : metric;
  const rows = useMemo(() => (q.data ? rankFriendsBoard(q.data, shownMetric) : []), [q.data, shownMetric]);
  const anyUnranked = shownMetric === 'rating' && rows.some((r) => r.rank === null);

  const header = (
    <View style={{ gap: t.space.md, paddingBottom: t.space.md }}>
      <View style={{ flexDirection: 'row', gap: t.space.sm }} accessibilityLabel={copy.friends.metricLabel}>
        <Chip
          label={copy.friends.week}
          icon="flash"
          selected={metric === 'week'}
          onPress={() => setMetric('week')}
          testID="metric-week"
        />
        <Chip
          label={copy.friends.rating}
          icon="shield-checkmark"
          selected={metric === 'rating'}
          onPress={() => setMetric('rating')}
          testID="metric-rating"
        />
      </View>
      {q.isError && q.data ? <RefreshFailedNote /> : null}
    </View>
  );

  if (q.data === undefined) {
    return (
      <View style={{ padding: t.space.lg, gap: t.space.md }}>
        {header}
        {q.isError ? <LoadFailed onRetry={() => void q.refetch()} /> : <ListSkeleton />}
      </View>
    );
  }

  const value = (r: RankedFriendRow) =>
    shownMetric === 'week' ? formatPointsValue(r.value ?? 0) : ratingText(r.value, r.ranked);

  return (
    <FlatList
      testID="friends-board"
      style={{ opacity: stale ? 0.6 : 1 }}
      data={rows}
      keyExtractor={(r) => r.user_id}
      contentContainerStyle={{ padding: t.space.lg }}
      ItemSeparatorComponent={RowSeparator}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={t.onSky.text} />}
      renderItem={({ item }) => (
        <BoardRow
          rank={item.rank}
          username={item.username}
          subtitle={`Level ${item.level}`}
          value={value(item)}
          unit={shownMetric === 'week' ? copy.pts : undefined}
          me={item.is_me}
          onPress={() => router.push(profileHref(item.username))}
          testID={`friend-row-${item.username}`}
        />
      )}
      ListFooterComponent={
        <View style={{ gap: t.space.lg, paddingTop: t.space.lg }}>
          {anyUnranked ? (
            <Text variant="footnote" tone="muted">
              {copy.friends.unrankedNote(units)}
            </Text>
          ) : null}
          {rows.length <= 1 ? (
            <EmptyState
              icon="people"
              title={copy.friends.emptyTitle}
              body={copy.friends.emptyBody}
              action={{ label: copy.friends.emptyAction, onPress: () => router.push(FRIENDS_ADD_HREF) }}
              testID="friends-empty"
            />
          ) : null}
        </View>
      }
    />
  );
}
