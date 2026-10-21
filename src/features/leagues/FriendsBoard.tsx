import { RANKED_MIN_MILES } from '@scoring';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { distanceIn, formatDistance, formatDistanceProgress, type Units } from '@/lib/units';
import { Card, EmptyState, useTheme } from '@/ui';

import { useFriendsBoard } from './api';
import { BoardNote, BoardRow, ListSkeleton, LoadFailed, RefreshFailedNote, RowSeparator, usePullRefresh } from './components';
import { leaguesCopy } from './copy';
import { rankFriendsBoard, ratingText, type RankedFriendRow } from './model';
import { FRIENDS_ADD_HREF, profileHref } from './routes';

const copy = leaguesCopy.friends;

/** The line under a driver's name: their 90-day distance, or how far they are from a rating; nothing when they don't share it. */
export function boardSubtitle(r: Pick<RankedFriendRow, 'rank' | 'miles_90d'>, units: Units): string | undefined {
  if (r.miles_90d === null || r.miles_90d === undefined) return undefined;
  if (r.rank !== null) return copy.miles(formatDistance(r.miles_90d, units, { digits: distanceIn(r.miles_90d, units) >= 10 ? 0 : 1 }));
  const p = formatDistanceProgress(r.miles_90d, RANKED_MIN_MILES, units);
  return copy.toRating(`${p.done} of ${p.target} ${units}`);
}

/** The Friends tab's board: you and your friends, ranked by Safety Rating over the last 90 days. */
export function FriendsBoard() {
  const t = useTheme();
  const router = useRouter();
  const units = useUnits();
  const q = useFriendsBoard();
  const pull = usePullRefresh(q.refetch);
  const rows = useMemo(() => (q.data ? rankFriendsBoard(q.data) : []), [q.data]);
  const anyUnrated = rows.some((r) => r.rank === null);

  if (q.data === undefined) {
    return (
      <View style={{ padding: t.space.lg, gap: t.space.md }}>
        {q.isError ? <LoadFailed onRetry={() => void q.refetch()} /> : <ListSkeleton />}
      </View>
    );
  }

  return (
    <FlatList
      testID="friends-board"
      data={rows}
      keyExtractor={(r) => r.user_id}
      contentContainerStyle={{ padding: t.space.lg }}
      ItemSeparatorComponent={RowSeparator}
      ListHeaderComponent={q.isError ? <View style={{ paddingBottom: t.space.md }}><RefreshFailedNote /></View> : null}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={t.onSky.text} />}
      renderItem={({ item }) => {
        const rated = item.rank !== null;
        return (
          <BoardRow
            rank={item.rank}
            username={item.username}
            subtitle={boardSubtitle(item, units)}
            value={rated ? ratingText(item.value, item.ranked) : '—'}
            valueLabel={rated ? undefined : copy.noRatingSpoken}
            me={item.is_me}
            onPress={() => router.push(profileHref(item.username))}
            testID={`friend-row-${item.username}`}
          />
        );
      }}
      ListFooterComponent={
        <View style={{ gap: t.space.lg, paddingTop: t.space.lg }}>
          {rows.length > 0 ? <BoardNote testID="friends-caption">{anyUnrated ? `${copy.caption}. ${copy.unratedNote(units)}` : copy.caption}</BoardNote> : null}
          {rows.length <= 1 ? (
            <Card padded={false}>
              <EmptyState
                icon="people"
                title={copy.emptyTitle}
                body={copy.emptyBody}
                action={{ label: copy.emptyAction, onPress: () => router.push(FRIENDS_ADD_HREF) }}
                testID="friends-empty"
              />
            </Card>
          ) : null}
        </View>
      }
    />
  );
}
