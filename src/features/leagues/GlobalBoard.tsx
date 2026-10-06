import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { Card, Chip, Divider, EmptyState, ListRow, Sheet, Text, useTheme } from '@/ui';

import { useGlobalBoard, type GlobalBoard as Board } from './api';
import {
  BoardRow,
  ListSkeleton,
  LoadFailed,
  RefreshFailedNote,
  RowSeparator,
  usePullRefresh,
} from './components';
import { leaguesCopy } from './copy';
import { percentileText, rankText } from './model';
import { profileHref } from './routes';
import { stateName, US_STATES } from './states';

const copy = leaguesCopy.global;

function MeCard({ me }: { me: Board['me'] }) {
  const t = useTheme();
  if (!me.eligible) {
    return (
      <Card variant="outline" testID="global-not-eligible">
        <Text variant="title3" accessibilityRole="header">
          {copy.notEligibleTitle}
        </Text>
        <Text variant="callout" tone="muted">
          {copy.notEligibleBody}
        </Text>
      </Card>
    );
  }
  if (me.percentile === null || me.rank === null) {
    return (
      <Text variant="callout" tone="muted" testID="global-not-in-state">
        {copy.notInState}
      </Text>
    );
  }
  return (
    <Card variant="hero" testID="global-me">
      <Text variant="title2" accessibilityRole="header">
        {percentileText(me.percentile)}
      </Text>
      <View style={{ flexDirection: 'row', gap: t.space.xl }}>
        <View accessible accessibilityLabel={`${copy.rank}: number ${me.rank}`}>
          <Text variant="stat">{rankText(me.rank)}</Text>
          <Text variant="label" tone="muted">
            {copy.rank}
          </Text>
        </View>
        {me.safety_rating !== null ? (
          <View accessible accessibilityLabel={`${copy.rating}: ${me.safety_rating.toFixed(1)}`}>
            <Text variant="stat">{me.safety_rating.toFixed(1)}</Text>
            <Text variant="label" tone="muted">
              {copy.rating}
            </Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

/** Everyone with 100+ mi in 30 days, by Safety Rating: the top 100 and your percentile. */
export function GlobalBoard() {
  const t = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const myId = session?.user.id ?? null;
  const [state, setState] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const q = useGlobalBoard(state);
  const pull = usePullRefresh(q.refetch);

  const choose = (code: string | null) => {
    setState(code);
    setPicking(false);
  };

  const filter = (
    <View style={{ flexDirection: 'row' }}>
      <Chip
        label={stateName(state) ?? copy.allStates}
        icon="location"
        selected={state !== null}
        onPress={() => setPicking(true)}
        accessibilityHint={copy.filterLabel}
        testID="state-filter"
      />
    </View>
  );

  const sheet = (
    <Sheet visible={picking} onClose={() => setPicking(false)} title={copy.sheetTitle} scroll testID="state-sheet">
      <Card padded={false} variant="raised">
        {[{ code: null as string | null, name: copy.allStates }, ...US_STATES].map((s, i) => (
          <View key={s.code ?? 'all'}>
            {i > 0 ? <Divider inset={16} /> : null}
            <ListRow
              title={s.name}
              onPress={() => choose(s.code)}
              accessory="none"
              trailing={
                s.code === state ? <Ionicons name="checkmark" size={20} color={t.colors.accent} /> : undefined
              }
              accessibilityLabel={s.code === state ? `${s.name}, selected` : s.name}
              testID={`state-${s.code ?? 'all'}`}
            />
          </View>
        ))}
      </Card>
    </Sheet>
  );

  // a new state filter keeps the last board on screen (dimmed) until its own lands
  const board = q.data;
  if (board === undefined) {
    return (
      <View style={{ padding: t.space.lg, gap: t.space.md }}>
        {filter}
        {q.isError ? <LoadFailed onRetry={() => void q.refetch()} /> : <ListSkeleton />}
        {sheet}
      </View>
    );
  }

  return (
    <>
      <FlatList
        testID="global-board"
        style={{ opacity: q.isPlaceholderData ? 0.6 : 1 }}
        data={board.top}
        keyExtractor={(r) => r.user_id}
        contentContainerStyle={{ padding: t.space.lg }}
        ItemSeparatorComponent={RowSeparator}
        ListHeaderComponent={
          <View style={{ gap: t.space.md, paddingBottom: t.space.md }}>
            {filter}
            {q.isError ? <RefreshFailedNote /> : null}
            <MeCard me={board.me} />
          </View>
        }
        ListEmptyComponent={
          <EmptyState icon="earth" title={copy.emptyTitle} body={copy.emptyBody} testID="global-empty" />
        }
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={t.colors.accent} />}
        renderItem={({ item }) => (
          <BoardRow
            rank={item.rank}
            username={item.username}
            subtitle={copy.cleanMiles(item.clean_miles)}
            value={item.safety_rating.toFixed(1)}
            me={item.user_id === myId}
            onPress={() => router.push(profileHref(item.username))}
            testID={`global-row-${item.rank}`}
          />
        )}
      />
      {sheet}
    </>
  );
}
