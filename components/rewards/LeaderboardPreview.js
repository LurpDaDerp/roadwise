// LeaderboardPreview — the top three drivers plus the signed-in user's rank.
// The whole card is one tap target that opens the full Leaderboard screen.
import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Card, Skeleton, AutoFitText, useTheme } from '../../theme';

const CROWNS = [
  require('../../assets/crown1.png'),
  require('../../assets/crown2.png'),
  require('../../assets/crown3.png'),
];

function Row({ rank, name, points, crownIndex, highlight, first }) {
  const t = useTheme();
  const color = highlight ? t.colors.accent : t.colors.text;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
        backgroundColor: highlight ? t.colors.accentFaint : 'transparent',
      }}
    >
      <View style={{ width: 30, alignItems: 'center', marginRight: 10 }}>
        <Text style={[t.typography.caption, { color: t.colors.textSubtle, fontWeight: '700' }]}>
          {rank}
        </Text>
      </View>
      {crownIndex != null && (
        <Image
          source={CROWNS[crownIndex]}
          style={{ width: 22, height: 22, marginRight: 8 }}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Rank ${rank} crown`}
        />
      )}
      <Text
        style={[t.typography.bodyStrong, { color, flex: 1, paddingRight: 12 }]}
        numberOfLines={1}
      >
        {name}
      </Text>
      <AutoFitText
        style={[t.typography.numeric, { color, fontSize: 16, lineHeight: 20, paddingRight: 4 }]}
      >
        {Number(points || 0).toLocaleString()}
      </AutoFitText>
    </View>
  );
}

function LoadingRows() {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 8 }}>
      {[0, 1, 2].map((i) => (
        <View
          key={`lb-skeleton-${i}`}
          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 }}
        >
          <Skeleton width={22} height={22} radius={11} />
          <Skeleton width={i === 0 ? 130 : 104} height={12} />
          <View style={{ flex: 1 }} />
          <Skeleton width={42} height={12} />
        </View>
      ))}
      <View style={{ height: 4, backgroundColor: 'transparent' }} />
      <Text style={[t.typography.caption, { color: t.colors.textSubtle, paddingBottom: 8 }]}>
        Loading standings
      </Text>
    </View>
  );
}

export default function LeaderboardPreview({
  rows = [],
  me = null,
  loading = false,
  error = false,
  onPress,
}) {
  const t = useTheme();
  const top = rows.slice(0, 3);
  const meInTop = !!me && top.some((r) => r.id === me.id);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Open the full leaderboard"
      style={({ pressed }) => [pressed && { opacity: 0.9 }]}
    >
      <Card padded={false} style={{ overflow: 'hidden' }}>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <View style={{ paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center' }}>
            <Text style={[t.typography.caption, { color: t.colors.textMuted, textAlign: 'center' }]}>
              Standings are unavailable right now. Tap to open the leaderboard and try again.
            </Text>
          </View>
        ) : top.length === 0 ? (
          <View style={{ paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center' }}>
            <Text style={[t.typography.caption, { color: t.colors.textMuted, textAlign: 'center' }]}>
              No drivers on the board yet. Finish a drive to claim a spot.
            </Text>
          </View>
        ) : (
          <>
            {top.map((row, i) => (
              <Row
                key={row.id}
                rank={i + 1}
                name={row.name}
                points={row.points}
                crownIndex={i}
                highlight={!!me && row.id === me.id}
                first={i === 0}
              />
            ))}
            {!!me && !meInTop && (
              <Row rank={me.rank} name={`${me.name} (You)`} points={me.points} highlight />
            )}
          </>
        )}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 18,
            paddingVertical: 12,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.colors.divider,
            backgroundColor: t.colors.surfaceAlt,
          }}
        >
          <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>
            See the full top 50
          </Text>
          <Ionicons name="chevron-forward" size={16} color={t.colors.textSubtle} />
        </View>
      </Card>
    </Pressable>
  );
}
