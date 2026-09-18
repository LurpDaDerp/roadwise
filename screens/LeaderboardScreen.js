// LeaderboardScreen — top 50 drivers by points, with a podium for the top three
// and the signed-in user's rank pinned when they fall outside the list.
// Refreshes on focus and on pull (the old build fetched once per app session).
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Image, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import {
  Screen,
  Section,
  Card,
  Button,
  ScreenHeader,
  Banner,
  EmptyState,
  Skeleton,
  AutoFitText,
  useTheme,
} from '../theme';
import { useAuthContext } from '../context/AuthContext';
import { fetchLeaderboard, LEADERBOARD_SIZE } from '../utils/leaderboard';

const CROWNS = [
  require('../assets/crown1.png'),
  require('../assets/crown2.png'),
  require('../assets/crown3.png'),
];

function initialOf(name) {
  const s = String(name || '').trim();
  return s ? s.charAt(0).toUpperCase() : '?';
}

function Avatar({ row, size, highlight }) {
  const t = useTheme();
  const border = {
    borderWidth: 2,
    borderColor: highlight ? t.colors.accent : t.colors.border,
  };
  if (row?.photoURL) {
    return (
      <ExpoImage
        source={{ uri: row.photoURL }}
        style={{ width: size, height: size, borderRadius: size / 2, ...border }}
        contentFit="cover"
        accessibilityLabel={`${row.name} profile photo`}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: highlight ? t.colors.accent : t.colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
        ...border,
      }}
    >
      <Text
        style={{
          color: highlight ? t.colors.accentText : t.colors.textMuted,
          fontSize: Math.round(size * 0.4),
          fontWeight: '800',
        }}
      >
        {initialOf(row?.name)}
      </Text>
    </View>
  );
}

function PodiumColumn({ row, place, isMe }) {
  const t = useTheme();
  if (!row) return <View style={{ flex: 1 }} />;
  const first = place === 1;
  const pedestalHeight = first ? 74 : place === 2 ? 56 : 44;

  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Image
        source={CROWNS[place - 1]}
        style={{ width: first ? 30 : 24, height: first ? 30 : 24, marginBottom: 6 }}
        resizeMode="contain"
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Rank ${place} crown`}
      />
      <Avatar row={row} size={first ? 60 : 48} highlight={first || isMe} />
      <Text
        style={[
          t.typography.caption,
          {
            color: isMe ? t.colors.accent : t.colors.text,
            fontWeight: '700',
            marginTop: 8,
            textAlign: 'center',
          },
        ]}
        numberOfLines={1}
      >
        {isMe ? 'You' : row.name}
      </Text>
      <AutoFitText
        style={[
          t.typography.numeric,
          {
            color: first ? t.colors.accent : t.colors.textMuted,
            fontSize: 16,
            lineHeight: 20,
            marginTop: 2,
          },
        ]}
      >
        {row.points.toLocaleString()}
      </AutoFitText>
      <View
        style={{
          marginTop: 10,
          width: '86%',
          height: pedestalHeight,
          borderTopLeftRadius: t.radius.md,
          borderTopRightRadius: t.radius.md,
          backgroundColor: first ? t.colors.accentFaint : t.colors.surfaceAlt,
          borderWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: 0,
          borderColor: t.colors.border,
          alignItems: 'center',
          paddingTop: 8,
        }}
      >
        <Text
          style={[
            t.typography.numeric,
            { color: first ? t.colors.accent : t.colors.textSubtle, fontSize: 20, lineHeight: 24 },
          ]}
        >
          {place}
        </Text>
      </View>
    </View>
  );
}

function Podium({ rows, myId }) {
  const order = [rows[1], rows[0], rows[2]];
  const places = [2, 1, 3];
  return (
    <Card
      padded={false}
      style={{ overflow: 'hidden', paddingTop: 18, paddingHorizontal: 10 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        {order.map((row, i) => (
          <PodiumColumn
            key={row ? row.id : `empty-${places[i]}`}
            row={row}
            place={places[i]}
            isMe={!!row && row.id === myId}
          />
        ))}
      </View>
    </Card>
  );
}

// Memoised: up to 50 rows are mounted at once, each formatting a number with toLocaleString.
const LeaderRow = React.memo(function LeaderRow({ rank, name, points, highlight, first }) {
  const t = useTheme();
  const color = highlight ? t.colors.accent : t.colors.text;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 13,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
        backgroundColor: highlight ? t.colors.accentFaint : 'transparent',
      }}
    >
      <View style={{ width: 34, alignItems: 'center', marginRight: 12 }}>
        <Text
          style={[
            t.typography.numeric,
            { color: highlight ? t.colors.accent : t.colors.textMuted, fontSize: 16, lineHeight: 20 },
          ]}
        >
          {rank}
        </Text>
      </View>
      <Text style={[t.typography.bodyStrong, { color, flex: 1, paddingRight: 14 }]} numberOfLines={1}>
        {name}
      </Text>
      <AutoFitText
        style={[t.typography.numeric, { color, fontSize: 16, lineHeight: 20, paddingRight: 4 }]}
      >
        {Number(points || 0).toLocaleString()}
      </AutoFitText>
    </View>
  );
});

function LoadingList() {
  return (
    <Card padded={false} style={{ paddingVertical: 8 }}>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <View
          key={`row-skeleton-${i}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 13,
            paddingHorizontal: 18,
            gap: 14,
          }}
        >
          <Skeleton width={18} height={12} />
          <Skeleton width={i % 2 === 0 ? 140 : 108} height={12} />
          <View style={{ flex: 1 }} />
          <Skeleton width={44} height={12} />
        </View>
      ))}
    </Card>
  );
}

export default function LeaderboardScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { uid } = useAuthContext();

  const [rows, setRows] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const activeRef = useRef(true);
  const hasRowsRef = useRef(false);

  const load = useCallback(
    async (mode = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else if (mode === 'initial') setLoading(true);
      setError(false);
      try {
        const result = await fetchLeaderboard(uid, LEADERBOARD_SIZE);
        if (!activeRef.current) return;
        setRows(result.rows);
        setMe(result.me);
        hasRowsRef.current = result.rows.length > 0;
      } catch (e) {
        console.warn('Leaderboard fetch failed:', e);
        if (activeRef.current) setError(true);
      } finally {
        if (activeRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [uid]
  );

  useFocusEffect(
    useCallback(() => {
      activeRef.current = true;
      load(hasRowsRef.current ? 'silent' : 'initial');
      return () => {
        activeRef.current = false;
      };
    }, [load])
  );

  const top = rows.slice(0, 3);
  const rest = rows.slice(3);
  const meInList = !!me && rows.some((r) => r.id === me.id);
  const showPinned = !!me && !meInList && !loading;

  return (
    <Screen hasHeader>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: showPinned ? 130 : 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load('refresh')}
            tintColor={t.colors.accent}
            colors={[t.colors.accent]}
          />
        }
      >
        <ScreenHeader
          align="left"
          eyebrow="Community"
          title="Leaderboard"
          subtitle="Top 50 safest drivers"
        />

        {error && (
          <Banner
            tone="danger"
            title="Standings unavailable"
            body="Check your connection and try again."
            style={{ marginBottom: t.spacing[5] }}
            right={
              <Button
                title="Retry"
                variant="soft"
                fullWidth={false}
                onPress={() => load(hasRowsRef.current ? 'silent' : 'initial')}
                style={{ paddingVertical: 8, paddingHorizontal: 14 }}
              />
            }
          />
        )}

        {loading ? (
          <LoadingList />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              icon="trophy-outline"
              title="No drivers ranked yet"
              body="Finish a focused drive to put yourself on the board."
            />
          </Card>
        ) : (
          <>
            <Section label="Podium">
              <Podium rows={top} myId={me?.id} />
            </Section>

            {rest.length > 0 && (
              <Section label={`Ranks 4-${rows.length}`}>
                <Card padded={false} style={{ overflow: 'hidden' }}>
                  {rest.map((row, i) => (
                    <LeaderRow
                      key={row.id}
                      rank={i + 4}
                      name={!!me && row.id === me.id ? `${row.name} (You)` : row.name}
                      points={row.points}
                      highlight={!!me && row.id === me.id}
                      first={i === 0}
                    />
                  ))}
                </Card>
              </Section>
            )}
          </>
        )}
      </ScrollView>

      {showPinned && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: Math.max(insets.bottom, t.spacing[4]),
          }}
          pointerEvents="box-none"
        >
          <Card padded={false} tone="raised" style={{ overflow: 'hidden' }}>
            <View
              style={{
                paddingHorizontal: 18,
                paddingTop: 10,
                backgroundColor: t.colors.accentFaint,
              }}
            >
              <Text style={[t.typography.micro, { color: t.colors.accent }]}>Your rank</Text>
            </View>
            <LeaderRow rank={me.rank} name={`${me.name} (You)`} points={me.points} highlight first />
          </Card>
        </View>
      )}
    </Screen>
  );
}
