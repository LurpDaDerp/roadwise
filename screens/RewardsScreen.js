// RewardsScreen (route `RewardsHome`) — balance, badges, leaderboard preview and
// the reward catalog. The balance reads the live Firestore profile through
// AuthContext; the old build read an AsyncStorage key that was never written.
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Snackbar } from 'react-native-paper';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  Screen,
  Section,
  Card,
  Button,
  ScreenHeader,
  Chip,
  Sheet,
  ProgressBar,
  AutoFitText,
  useCountUp,
  useTheme,
} from '../theme';
import { useAuthContext } from '../context/AuthContext';
import { getDriveCounts } from '../utils/firestore';
import { getBadgeDrives } from '../utils/driveCache';
import { computeBadges } from '../utils/achievements';
import { fetchLeaderboard } from '../utils/leaderboard';
import { BadgeGrid, LeaderboardPreview, RewardCategoryTile } from '../components/rewards';

const CATEGORIES = [
  { id: 'food', label: 'Food & Drink', icon: 'restaurant-outline', image: require('../assets/foodback.jpg') },
  { id: 'shopping', label: 'Shopping', icon: 'bag-handle-outline', image: require('../assets/shopback.jpg') },
  { id: 'games', label: 'Games & Entertainment', icon: 'game-controller-outline', image: require('../assets/gameback.jpg') },
  { id: 'subscriptions', label: 'Subscriptions', icon: 'repeat-outline', image: require('../assets/subback.jpg') },
];

const STREAK_EXPLAINER =
  'Every focused drive adds 1. A phone pickup or a critical monitoring alert resets it.';

export default function RewardsScreen({ navigation }) {
  const t = useTheme();
  const { uid, points, streak } = useAuthContext();

  const [drives, setDrives] = useState([]);
  const [totalDrives, setTotalDrives] = useState(null);
  const [drivesLoading, setDrivesLoading] = useState(true);
  const [board, setBoard] = useState({ rows: [], me: null });
  const [boardLoading, setBoardLoading] = useState(true);
  const [boardError, setBoardError] = useState(false);

  const [selectedBadge, setSelectedBadge] = useState(null);
  const [streakOpen, setStreakOpen] = useState(false);
  const [snackbar, setSnackbar] = useState(false);

  const displayPoints = useCountUp(points);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (!uid) {
        setDrives([]);
        setDrivesLoading(false);
        setBoard({ rows: [], me: null });
        setBoardLoading(false);
        return undefined;
      }

      setDrivesLoading(true);
      setBoardLoading(true);
      setBoardError(false);

      (async () => {
        // Badges need recent history, not the whole collection: the newest 200 drives
        // plus a server count for the totals-based badges.
        const [list, counts] = await Promise.all([getBadgeDrives(uid), getDriveCounts(uid)]);
        if (!active) return;
        setDrives(Array.isArray(list) ? list : []);
        setTotalDrives(counts?.total ?? null);
        setDrivesLoading(false);
      })();

      (async () => {
        try {
          const result = await fetchLeaderboard(uid, 3);
          if (!active) return;
          setBoard(result);
          setBoardError(false);
        } catch (e) {
          console.warn('Leaderboard preview failed:', e);
          if (active) setBoardError(true);
        } finally {
          if (active) setBoardLoading(false);
        }
      })();

      return () => {
        active = false;
      };
    }, [uid])
  );

  const badges = useMemo(
    () => computeBadges({ drives, streak, points, totalDrives }),
    [drives, streak, points, totalDrives]
  );
  const unlockedCount = badges.filter((b) => b.unlocked).length;

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        <ScreenHeader eyebrow="Rewards" title="Earn and compete" />

        <Card padded={false} style={{ overflow: 'hidden', marginBottom: t.spacing[6] }}>
          <View
            style={{
              padding: 20,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={[t.typography.micro, { color: t.colors.textMuted }]}>
                Available balance
              </Text>
              <AutoFitText
                style={[
                  t.typography.numeric,
                  { color: t.colors.text, marginTop: 6, fontSize: 44, lineHeight: 48 },
                ]}
              >
                {displayPoints.toLocaleString()}
              </AutoFitText>
              <Text style={[t.typography.caption, { color: t.colors.accent, marginTop: 2 }]}>
                points
              </Text>
            </View>

            <Pressable
              onPress={() => setStreakOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: streakOpen }}
              accessibilityLabel={`Focus streak ${streak}. How the streak works`}
              hitSlop={8}
              style={({ pressed }) => [pressed && { opacity: 0.8 }]}
            >
              <Chip icon="flame" label={`Streak ${streak}`} tone="warning" size="md" />
            </Pressable>
          </View>

          {streakOpen && (
            <View
              style={{
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: t.colors.divider,
                paddingHorizontal: 20,
                paddingVertical: 12,
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
              }}
            >
              <Ionicons name="flame-outline" size={16} color={t.colors.warning} />
              <Text style={[t.typography.caption, { color: t.colors.textMuted, flex: 1 }]}>
                {STREAK_EXPLAINER}
              </Text>
            </View>
          )}
        </Card>

        <Section
          label="Badges"
          actions={<Chip label={`${unlockedCount} of ${badges.length}`} tone="accent" />}
        >
          <BadgeGrid badges={badges} loading={drivesLoading} onSelect={setSelectedBadge} />
        </Section>

        <Section label="Leaderboard">
          <LeaderboardPreview
            rows={board.rows}
            me={board.me}
            loading={boardLoading}
            error={boardError}
            onPress={() => navigation.navigate('Leaderboard')}
          />
        </Section>

        <Section
          label="Reward catalog"
          actions={<Chip label="Coming soon" tone="info" />}
        >
          <View style={{ gap: 12 }}>
            {CATEGORIES.map((c) => (
              <RewardCategoryTile
                key={c.id}
                label={c.label}
                icon={c.icon}
                image={c.image}
                onPress={() => setSnackbar(true)}
              />
            ))}
          </View>
        </Section>
      </ScrollView>

      <Sheet
        visible={!!selectedBadge}
        onClose={() => setSelectedBadge(null)}
        eyebrow={selectedBadge?.unlocked ? 'Unlocked' : 'Locked'}
        title={selectedBadge?.title}
      >
        {!!selectedBadge && (
          <View>
            <Text style={[t.typography.body, { color: t.colors.textMuted }]}>
              {selectedBadge.body}
            </Text>
            <View style={{ marginTop: 18 }}>
              <ProgressBar value={selectedBadge.fraction} />
              <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 8 }]}>
                {selectedBadge.unlocked
                  ? 'Earned'
                  : `${selectedBadge.progress} of ${selectedBadge.target}`}
              </Text>
            </View>
            <Button
              title="Close"
              variant="ghost"
              onPress={() => setSelectedBadge(null)}
              style={{ marginTop: 20 }}
            />
          </View>
        )}
      </Sheet>

      <Snackbar
        visible={snackbar}
        onDismiss={() => setSnackbar(false)}
        duration={3000}
        style={{
          backgroundColor: t.colors.surfaceRaised,
          borderRadius: t.radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          marginBottom: 12,
        }}
        theme={{ colors: { onSurface: t.colors.text } }}
        action={{ label: 'OK', onPress: () => setSnackbar(false) }}
      >
        <Text style={{ color: t.colors.text, fontSize: 14 }}>
          Reward partners are on the way. Keep earning points.
        </Text>
      </Snackbar>
    </Screen>
  );
}
