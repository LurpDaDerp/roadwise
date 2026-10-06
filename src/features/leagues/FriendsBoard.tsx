import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { Chip, EmptyState, formatPointsValue, Text, useTheme } from '@/ui';

import { useFriendsBoard, type FriendsMetric } from './api';
import { BoardRow, ListSkeleton, LoadFailed, RefreshFailedNote, usePullRefresh } from './components';
import { leaguesCopy } from './copy';
import { rankFriendsBoard, ratingText, type RankedFriendRow } from './model';
import { FRIENDS_ADD_HREF, profileHref } from './routes';

const copy = leaguesCopy;

/** Friends & clan: you, your friends and your clanmates, by week points or Safety Rating. */
export function FriendsBoard() {
  const t = useTheme();
  const router = useRouter();
  const [metric, setMetric] = useState<FriendsMetric>('week');
  const q = useFriendsBoard(metric);
  const pull = usePullRefresh(q.refetch);
  const rows = useMemo(() => (q.data ? rankFriendsBoard(q.data, metric) : []), [q.data, metric]);
  const anyUnranked = metric === 'rating' && rows.some((r) => r.rank === null);

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
    metric === 'week' ? formatPointsValue(r.value ?? 0) : ratingText(r.value, r.ranked);

  return (
    <FlatList
      testID="friends-board"
      data={rows}
      keyExtractor={(r) => r.user_id}
      contentContainerStyle={{ padding: t.space.lg }}
      ItemSeparatorComponent={() => <View style={{ height: t.space.xs }} />}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={t.colors.accent} />}
      renderItem={({ item }) => (
        <BoardRow
          rank={item.rank}
          username={item.username}
          subtitle={`Level ${item.level}`}
          value={value(item)}
          unit={metric === 'week' ? copy.pts : undefined}
          me={item.is_me}
          onPress={() => router.push(profileHref(item.username))}
          testID={`friend-row-${item.username}`}
        />
      )}
      ListFooterComponent={
        <View style={{ gap: t.space.lg, paddingTop: t.space.lg }}>
          {anyUnranked ? (
            <Text variant="footnote" tone="muted">
              {copy.friends.unrankedNote}
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
