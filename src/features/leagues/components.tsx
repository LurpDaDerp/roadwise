/**
 * Pieces the boards share: a leaderboard row, load failure and loading states, and pull to
 * refresh. The boards scroll under a fixed header, so their lists sit on the sky behind the tabs:
 * anything with text has a paper ground (a card or a row tile), never the open sky.
 */
import { useCallback, useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { Avatar, Card, EmptyState, Pill, Skeleton, Text, tokens, useTheme } from '@/ui';

import { leaguesCopy } from './copy';

const copy = leaguesCopy;

// ---------------------------------------------------------------------------
// pull to refresh
// ---------------------------------------------------------------------------

/**
 * The spinner only shows for a pull the user made, not for a focus refetch (those keep the board on screen without a flicker).
 */
export function usePullRefresh(refetch: () => Promise<unknown>): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);
  return { refreshing, onRefresh };
}

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

/** The gap between leaderboard tiles; a module-level component so a refetch never remounts it. */
export function RowSeparator() {
  return <View style={{ height: tokens.space.xs }} />;
}

export function LoadFailed({ onRetry, title, body }: { onRetry: () => void; title?: string; body?: string }) {
  return (
    <Card padded={false}>
      <EmptyState
        icon="cloud-offline-outline"
        title={title ?? copy.loadFailed.title}
        body={body ?? copy.loadFailed.body}
        action={{ label: copy.loadFailed.retry, onPress: onRetry }}
        testID="load-failed"
      />
    </Card>
  );
}

/** Row-shaped placeholders while the first load runs. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }} testID="list-skeleton" accessibilityLabel="Loading" accessible>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width="100%" height={60} radius={t.radius.lg} />
      ))}
    </View>
  );
}

/** A note on a board, on its own paper ground (the board sits on the sky). */
export function BoardNote({ children, testID }: { children: string; testID?: string }) {
  return (
    <Card>
      <Text variant="footnote" tone="muted" testID={testID}>
        {children}
      </Text>
    </Card>
  );
}

/** A quiet line when a background refresh failed but the last board is still on screen. */
export function RefreshFailedNote() {
  return <BoardNote testID="refresh-failed">{copy.refreshFailed}</BoardNote>;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

export type BoardRowProps = {
  /** Null: listed but not placed (a driver without a rating yet). */
  rank: number | null;
  username: string;
  /** The line under the name; none when there is nothing to say. */
  subtitle?: string;
  value: string;
  unit?: string;
  /** How the value reads aloud, when "value unit" isn't clear on its own. */
  valueLabel?: string;
  me?: boolean;
  onPress?: () => void;
  accessibilityHint?: string;
  testID?: string;
};

/**
 * One leaderboard tile: place, avatar, username and a line under it, and the number that ranks
 * it. Your own row is outlined in the accent and says "You", so colour is never the only cue.
 */
export function BoardRow({
  rank,
  username,
  subtitle,
  value,
  unit,
  valueLabel,
  me = false,
  onPress,
  accessibilityHint,
  testID,
}: BoardRowProps) {
  const t = useTheme();
  const c = t.colors;

  const tile: ViewStyle = {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
    paddingVertical: t.space.sm,
    paddingLeft: t.space.md,
    paddingRight: t.space.lg,
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    backgroundColor: me ? c.accentFaint : c.surface,
    borderWidth: me ? 1.5 : 0,
    borderColor: c.accent,
  };

  const label = [
    rank === null ? 'Not placed' : `Number ${rank}`,
    username,
    me ? copy.you : null,
    subtitle,
    valueLabel ?? (unit ? `${value} ${unit}` : value),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={tile} testID={testID}>
      <Pressable
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        disabled={!onPress}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.space.md,
          minHeight: t.size.touch,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <View style={{ width: 34, alignItems: 'center' }}>
          <Text variant="title3" tone={rank === null ? 'subtle' : 'default'} style={{ fontVariant: ['tabular-nums'] }}>
            {rank === null ? '–' : rank}
          </Text>
        </View>
        <Avatar username={username} size="sm" />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, flexWrap: 'wrap' }}>
            <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
              {username}
            </Text>
            {me ? <Pill label={copy.you} tone="accent" emphasis="solid" accessible={false} /> : null}
          </View>
          {subtitle ? (
            <Text variant="footnote" tone="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text variant="title3" style={{ fontVariant: ['tabular-nums'] }}>
            {value}
          </Text>
          {unit ? <Text variant="caption" tone="muted">{unit}</Text> : null}
        </View>
      </Pressable>
    </View>
  );
}
