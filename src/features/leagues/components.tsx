/**
 * Pieces the boards share (and the Clan tab borrows): a leaderboard row, the zone line, load
 * failure and loading states, a minute clock for the countdown, and pull to refresh.
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { Avatar, Button, EmptyState, Pill, Skeleton, Text, tokens, useTheme } from '@/ui';

import { leaguesCopy } from './copy';
import { endsInLabel, formatEndsIn, msToNextMinute, type Zone } from './model';

const copy = leaguesCopy;

// ---------------------------------------------------------------------------
// minute clock
// ---------------------------------------------------------------------------

/** `Date.now()`, re-read on every whole minute. Only the component that calls it re-renders. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, msToNextMinute(Date.now()));
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}

/** "Ends in 2d 4h", ticking once a minute without re-rendering the board around it. */
export function Countdown({ endsAt, testID }: { endsAt: string; testID?: string }) {
  const now = useMinuteClock();
  const end = Date.parse(endsAt);
  return (
    <View accessible accessibilityLabel={endsInLabel(end, now)} testID={testID}>
      <Pill label={formatEndsIn(end, now)} icon="time-outline" tone="gold" accessible={false} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// pull to refresh
// ---------------------------------------------------------------------------

/**
 * The spinner only shows for a pull the user made, not for the background poll or a focus
 * refetch (those keep the board on screen without a flicker).
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
    <EmptyState
      icon="cloud-offline-outline"
      title={title ?? copy.loadFailed.title}
      body={body ?? copy.loadFailed.body}
      action={{ label: copy.loadFailed.retry, onPress: onRetry }}
      testID="load-failed"
    />
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

/** A quiet line when a background refresh failed but the last board is still on screen. */
export function RefreshFailedNote() {
  return (
    <Text variant="footnote" tone="muted" testID="refresh-failed">
      {copy.refreshFailed}
    </Text>
  );
}

export function RetryButton({ onPress }: { onPress: () => void }) {
  return <Button label={copy.loadFailed.retry} variant="secondary" size="sm" onPress={onPress} />;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

const ZONE_WORD: Record<Zone, string | null> = { up: 'moves up', stay: null, down: 'moves down' };

export type BoardRowProps = {
  /** Null: listed but not placed (an unranked driver on the rating board). */
  rank: number | null;
  username: string;
  subtitle: string;
  value: string;
  unit?: string;
  /** How the value reads aloud, when "value unit" isn't clear on its own. */
  valueLabel?: string;
  me?: boolean;
  zone?: Zone;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Extra node after the username (a role pill), and what it says to a screen reader. */
  badge?: React.ReactNode;
  badgeLabel?: string;
  /** Extra trailing control (a menu button), outside the row's press target. */
  accessory?: React.ReactNode;
  accessibilityHint?: string;
  testID?: string;
};

/**
 * One leaderboard tile: place, avatar, username and a line under it, and the number that ranks
 * it. Your own row is outlined in the accent; zone rows carry a tint *and* an arrow and the
 * spoken zone, so colour is never the only cue.
 */
export function BoardRow({
  rank,
  username,
  subtitle,
  value,
  unit,
  valueLabel,
  me = false,
  zone = 'stay',
  onPress,
  onLongPress,
  badge,
  badgeLabel,
  accessory,
  accessibilityHint,
  testID,
}: BoardRowProps) {
  const t = useTheme();
  const c = t.colors;
  const zoneColor = zone === 'up' ? c.signal.clean : zone === 'down' ? c.signal.severe : null;

  const tile: ViewStyle = {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
    paddingVertical: t.space.sm,
    paddingLeft: t.space.md,
    paddingRight: accessory ? t.space.xs : t.space.lg,
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    backgroundColor: me ? c.accentFaint : zoneColor ? zoneColor.faint : c.surface,
    borderWidth: me ? 1.5 : 0,
    borderColor: c.accent,
  };

  const label = [
    rank === null ? 'Not placed' : `Number ${rank}`,
    username,
    me ? copy.you : null,
    badgeLabel,
    subtitle,
    valueLabel ?? (unit ? `${value} ${unit === copy.pts ? 'points' : unit}` : value),
    ZONE_WORD[zone],
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
        onLongPress={onLongPress}
        disabled={!onPress && !onLongPress}
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
          {zoneColor ? (
            <Ionicons name={zone === 'up' ? 'caret-up' : 'caret-down'} size={12} color={zoneColor.text} />
          ) : null}
        </View>
        <Avatar username={username} size="sm" />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, flexWrap: 'wrap' }}>
            <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
              {username}
            </Text>
            {me ? <Pill label={copy.you} tone="accent" emphasis="solid" accessible={false} /> : null}
            {badge}
          </View>
          <Text variant="footnote" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text variant="title3" style={{ fontVariant: ['tabular-nums'] }}>
            {value}
          </Text>
          {unit ? <Text variant="caption" tone="muted">{unit}</Text> : null}
        </View>
      </Pressable>
      {accessory}
    </View>
  );
}

/** The labelled line between zones: "Moves up" under the top spots, "Moves down" above the bottom. */
export function ZoneDivider({ zone }: { zone: 'up' | 'down' }) {
  const t = useTheme();
  const color = zone === 'up' ? t.colors.signal.clean.text : t.colors.signal.severe.text;
  const word = zone === 'up' ? copy.league.movesUp : copy.league.movesDown;
  const line = <View style={{ flex: 1, height: 1.5, backgroundColor: color, opacity: 0.5 }} />;
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={zone === 'up' ? `${word}: everyone above this line` : `${word}: everyone below this line`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: t.space.sm }}
      testID={`zone-${zone}`}
    >
      {line}
      <Ionicons name={zone === 'up' ? 'arrow-up-circle' : 'arrow-down-circle'} size={16} color={color} />
      <Text variant="label" style={{ color }}>
        {word}
      </Text>
      {line}
    </View>
  );
}
