// BadgeGrid — three-column grid of achievement badges.
// Unlocked badges render in the accent colour; locked ones are muted and show a
// progress bar with an "n/target" caption. Tapping a badge calls onSelect.
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, ProgressBar, Skeleton, useTheme } from '../../theme';

const COLUMN_WIDTH = '33.33%';

function BadgeTile({ badge, onPress }) {
  const t = useTheme();
  const unlocked = !!badge.unlocked;
  const fg = unlocked ? t.colors.accent : t.colors.textSubtle;

  return (
    <View style={{ width: COLUMN_WIDTH, padding: 5 }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={
          unlocked
            ? `${badge.title}, unlocked`
            : `${badge.title}, locked, ${badge.progress} of ${badge.target}`
        }
        android_ripple={{ color: t.colors.accentFaint, borderless: false }}
        style={({ pressed }) => [
          {
            alignItems: 'center',
            paddingVertical: 12,
            paddingHorizontal: 6,
            borderRadius: t.radius.md,
            backgroundColor: unlocked ? t.colors.accentFaint : t.colors.surfaceAlt,
          },
          pressed && { opacity: 0.85 },
        ]}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: unlocked ? t.colors.accent : t.colors.surface,
            marginBottom: 8,
          }}
        >
          <Ionicons
            name={badge.icon}
            size={22}
            color={unlocked ? t.colors.accentText : t.colors.textSubtle}
          />
        </View>

        <Text
          style={[
            t.typography.caption,
            { color: unlocked ? t.colors.text : t.colors.textMuted, textAlign: 'center' },
          ]}
          numberOfLines={2}
        >
          {badge.title}
        </Text>

        {unlocked ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
            <Ionicons name="checkmark-circle" size={12} color={t.colors.accent} />
            <Text style={[t.typography.caption, { color: fg, fontSize: 11 }]}>Unlocked</Text>
          </View>
        ) : (
          <View style={{ alignSelf: 'stretch', marginTop: 8, paddingHorizontal: 2 }}>
            <ProgressBar value={badge.fraction} height={4} />
            <Text
              style={[
                t.typography.caption,
                { color: t.colors.textSubtle, fontSize: 11, textAlign: 'center', marginTop: 4 },
              ]}
              numberOfLines={1}
            >
              {`${badge.progress}/${badge.target}`}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function LoadingTile() {
  const t = useTheme();
  return (
    <View style={{ width: COLUMN_WIDTH, padding: 5 }}>
      <View
        style={{
          alignItems: 'center',
          paddingVertical: 12,
          borderRadius: t.radius.md,
          backgroundColor: t.colors.surfaceAlt,
        }}
      >
        <Skeleton width={44} height={44} radius={22} />
        <Skeleton width={56} height={10} style={{ marginTop: 10 }} />
        <Skeleton width={34} height={8} style={{ marginTop: 8 }} />
      </View>
    </View>
  );
}

export default function BadgeGrid({ badges = [], loading = false, onSelect }) {
  const t = useTheme();
  const placeholders = [0, 1, 2, 3, 4, 5];

  return (
    <Card padded={false} style={{ padding: 15 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {loading
          ? placeholders.map((i) => <LoadingTile key={`badge-skeleton-${i}`} />)
          : badges.map((badge) => (
              <BadgeTile
                key={badge.id}
                badge={badge}
                onPress={() => onSelect && onSelect(badge)}
              />
            ))}
      </View>
      {!loading && badges.length === 0 && (
        <Text
          style={[
            t.typography.caption,
            { color: t.colors.textMuted, textAlign: 'center', paddingVertical: 16 },
          ]}
        >
          Badges appear after your first drive.
        </Text>
      )}
    </Card>
  );
}
