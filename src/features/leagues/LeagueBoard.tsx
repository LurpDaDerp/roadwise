import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { Banner, Card, EmptyState, formatPointsValue, Text, TIER_LABEL, TierBadge, useTheme } from '@/ui';

import { useMyLeague, type MyLeague } from './api';
import {
  BoardRow,
  Countdown,
  ListSkeleton,
  LoadFailed,
  RefreshFailedNote,
  usePullRefresh,
  ZoneDivider,
} from './components';
import { leaguesCopy } from './copy';
import {
  drivesToMoveUp,
  lastResultText,
  leagueBoardItems,
  leagueZone,
  nextTier,
  previousTier,
  rankText,
  type BoardItem,
} from './model';
import { profileHref } from './routes';

const copy = leaguesCopy.league;

/** The rules line for this tier: no moving up from Diamond, no moving down from Bronze. */
function rulesText(league: MyLeague): string {
  const parts: string[] = [];
  if (nextTier(league.tier)) parts.push(`Top ${league.promote} move up`);
  if (previousTier(league.tier)) parts.push(`Bottom ${league.demote} move down`);
  if (nextTier(league.tier)) parts.push(copy.minDrives(league.min_drives_to_promote));
  return parts.join(' · ');
}

function LeagueHeader({ league }: { league: MyLeague }) {
  const t = useTheme();
  const tierName = TIER_LABEL[league.tier];
  const me = league.members.find((m) => m.is_me);
  const short = me && leagueZone(me.rank, league) === 'up' ? drivesToMoveUp(me.drives, league.min_drives_to_promote) : 0;

  if (!league.placed) {
    return (
      <Card variant="hero" testID="league-unplaced">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.lg }}>
          <TierBadge tier={league.tier} size="lg" showLabel={false} />
          <View style={{ flex: 1, gap: t.space.sm, alignItems: 'flex-start' }}>
            <Text variant="title2" accessibilityRole="header">
              {copy.unplacedTitle(tierName)}
            </Text>
            <Countdown endsAt={league.ends_at} />
          </View>
        </View>
        <Text variant="callout" tone="muted">
          {copy.unplacedBody}
        </Text>
      </Card>
    );
  }

  return (
    <Card variant="hero" testID="league-header">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <TierBadge tier={league.tier} size="md" showLabel={false} />
        <View style={{ flex: 1, gap: t.space.xs, alignItems: 'flex-start' }}>
          <Text variant="title2" accessibilityRole="header">
            {copy.leagueName(tierName)}
          </Text>
          <Countdown endsAt={league.ends_at} testID="league-countdown" />
        </View>
      </View>
      {me ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}
          accessible
          accessibilityLabel={`You're number ${me.rank} of ${league.size}, ${formatPointsValue(me.week_points)} points this week`}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs }}>
            <Text variant="display">{rankText(me.rank)}</Text>
            <Text variant="headline" tone="muted">
              {copy.ofSize(league.size)}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text variant="stat">{formatPointsValue(me.week_points)}</Text>
            <Text variant="label" tone="muted">
              {copy.weekPoints}
            </Text>
          </View>
        </View>
      ) : null}
      <Text variant="footnote" tone="muted" testID="league-rules">
        {rulesText(league)}
      </Text>
      {short > 0 ? (
        <Text variant="callout" testID="league-drives-left">
          {copy.drivesLeft(short)}
        </Text>
      ) : null}
    </Card>
  );
}

/** The weekly league: 30 drivers of one tier, top 7 up and bottom 5 down every Monday. */
export function LeagueBoard() {
  const t = useTheme();
  const router = useRouter();
  const q = useMyLeague();
  const pull = usePullRefresh(q.refetch);
  const league = q.data;
  const items = useMemo<BoardItem[]>(() => (league?.placed ? leagueBoardItems(league) : []), [league]);

  if (league === undefined) {
    return (
      <View style={{ padding: t.space.lg }}>
        {q.isError ? <LoadFailed onRetry={() => void q.refetch()} /> : <ListSkeleton />}
      </View>
    );
  }

  const result = lastResultText(league);
  const header = (
    <View style={{ gap: t.space.md, paddingBottom: t.space.md }}>
      {q.isError ? <RefreshFailedNote /> : null}
      {result ? (
        <Banner
          tone={league.last_result?.result === 'promoted' ? 'success' : 'info'}
          message={result}
          testID="last-result"
        />
      ) : null}
      {league.eligible ? (
        <LeagueHeader league={league} />
      ) : (
        <EmptyState
          icon="phone-portrait-outline"
          title={copy.ineligibleTitle}
          body={copy.ineligibleBody}
          testID="league-ineligible"
        />
      )}
    </View>
  );

  return (
    <FlatList
      testID="league-board"
      data={items}
      // a group is at most 30 rows and two lines: draw it all so the bottom zone is there on a fling
      initialNumToRender={32}
      keyExtractor={(item) => (item.kind === 'row' ? item.member.user_id : `divider-${item.zone}`)}
      contentContainerStyle={{ padding: t.space.lg }}
      ItemSeparatorComponent={() => <View style={{ height: t.space.xs }} />}
      ListHeaderComponent={header}
      ListFooterComponent={
        league.placed ? (
          <Text variant="footnote" tone="muted" style={{ paddingTop: t.space.lg }}>
            {copy.resets}
          </Text>
        ) : null
      }
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={t.colors.accent} />}
      renderItem={({ item }) =>
        item.kind === 'divider' ? (
          <ZoneDivider zone={item.zone} />
        ) : (
          <BoardRow
            rank={item.member.rank}
            username={item.member.username}
            subtitle={`Level ${item.member.level} · ${item.member.drives} ${item.member.drives === 1 ? 'drive' : 'drives'}`}
            value={formatPointsValue(item.member.week_points)}
            unit={leaguesCopy.pts}
            me={item.member.is_me}
            zone={item.zone}
            onPress={() => router.push(profileHref(item.member.username))}
            testID={`league-row-${item.member.rank}`}
          />
        )
      }
    />
  );
}
