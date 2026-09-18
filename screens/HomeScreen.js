// HomeScreen — everything points at "Start drive"; then stats, this week,
// safety score, recent drives and the family card.
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, getDoc } from 'firebase/firestore';

import { Screen, Section, Card, ScreenHeader, Button, StatCell, StatDivider, ListRow, EmptyState, Skeleton, Sheet, Ring, scoreColor, Chip, useTheme, useCountUp } from '../theme';
import { db } from '../utils/firebase';
import { getRecentDrives } from '../utils/firestore';
import { summarizeDrives } from '../utils/driveScore';
import { formatDistance, toDate, serializeDrive } from '../utils/format';
import { KEYS } from '../utils/storageKeys';
import { useAuthContext } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { StartDriveCard, StreakPill, RecentDriveRow } from '../components/home';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen({ navigation }) {
  const t = useTheme();
  const { uid, username, points, streak, groupId, profileLoaded } = useAuthContext();
  const { settings } = useSettings();
  const [drives, setDrives] = useState(null); // null = loading
  const [safetyScore, setSafetyScore] = useState(null);
  const [family, setFamily] = useState(null); // { name, members, emergencies }
  const [refreshing, setRefreshing] = useState(false);
  const [streakInfo, setStreakInfo] = useState(false);

  const shownPoints = useCountUp(points, 450);
  const unit = settings.speedUnit;

  const load = useCallback(async () => {
    if (!uid) return;
    try {
      const [recent, storedScore] = await Promise.all([getRecentDrives(uid, 30), AsyncStorage.getItem(KEYS.safetyScoreFor(uid))]);
      setDrives(recent);
      const parsed = storedScore != null ? parseInt(storedScore, 10) : NaN;
      setSafetyScore(Number.isFinite(parsed) ? parsed : null);
    } catch (e) {
      setDrives([]);
    }
    if (groupId) {
      try {
        const snap = await getDoc(doc(db, 'groups', groupId));
        if (snap.exists()) {
          const data = snap.data();
          const members = Object.values(data.memberLocations || {});
          setFamily({ name: data.groupName || 'Your group', members: members.length, emergencies: members.filter((m) => m?.emergency).length });
        } else setFamily(null);
      } catch {
        setFamily(null);
      }
    } else {
      setFamily(null);
    }
  }, [uid, groupId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const week = useMemo(() => {
    if (!drives) return null;
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    return summarizeDrives(drives.filter((d) => toDate(d.timestamp).getTime() >= cutoff));
  }, [drives]);

  const totalDrives = drives ? drives.length : null;
  const isNew = drives && drives.length === 0;
  const monitoringLine = settings.monitoringEnabled ? `Monitoring on · ${settings.monitoringDriverSide} seat` : 'Driver monitoring off';

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.colors.accent} />}
      >
        <ScreenHeader
          eyebrow={greeting()}
          title={username ? username : 'Driver'}
          subtitle={new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          right={<StreakPill streak={streak} onPress={() => setStreakInfo(true)} />}
        />

        <Section>
          <StartDriveCard onPress={() => navigation.navigate('DrivePrep')} subtitle={monitoringLine} />
        </Section>

        {isNew ? (
          <Section label="Your first drive">
            <Card padded={false}>
              <ListRow first icon="phone-portrait-outline" title="Mount the phone" subtitle="Dash or windshield, screen facing you." />
              <ListRow icon="play-outline" title="Tap Start drive" subtitle="Points begin once you are moving." />
              <ListRow icon="eye-outline" title="Leave it alone" subtitle="Picking up the phone resets your streak." />
              <ListRow icon="gift-outline" title="Earn and compete" subtitle="Points, badges and the leaderboard live in Rewards." />
            </Card>
          </Section>
        ) : (
          <Section label="My stats">
            <Card>
              <View style={{ flexDirection: 'row' }}>
                <StatCell label="Points" value={profileLoaded ? shownPoints.toLocaleString() : '—'} color={t.colors.accent} />
                <StatDivider />
                <StatCell label="Drives" value={totalDrives == null ? '—' : totalDrives >= 30 ? '30+' : String(totalDrives)} />
                <StatDivider />
                <StatCell label="Streak" value={String(streak)} />
              </View>
            </Card>
          </Section>
        )}

        {week && week.count > 0 && (
          <Section label="This week">
            <Card>
              <View style={{ flexDirection: 'row' }}>
                <StatCell label="Drives" value={String(week.count)} size="sm" />
                <StatDivider />
                <StatCell label="Focused" value={week.focusedPct != null ? `${week.focusedPct}%` : '—'} size="sm" color={week.focusedPct >= 80 ? t.colors.accent : week.focusedPct >= 50 ? t.colors.warning : t.colors.danger} />
                <StatDivider />
                <StatCell label="Distance" value={formatDistance(week.distance, unit)} size="sm" />
                {week.eyesOffRoadSeconds > 0 && (
                  <>
                    <StatDivider />
                    <StatCell label="Eyes off" value={`${Math.round(week.eyesOffRoadSeconds)}s`} size="sm" color={t.colors.warning} />
                  </>
                )}
              </View>
            </Card>
          </Section>
        )}

        <Section label="Safety score">
          <Card onPress={() => navigation.navigate('Drives', { screen: 'DrivesHome', params: { tab: 'insights' } })}>
            {safetyScore !== null ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <Ring value={safetyScore} size={76} stroke={8} />
                <View style={{ flex: 1 }}>
                  <Text style={[t.typography.subheading, { color: t.colors.text }]}>AI safety rating</Text>
                  <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}>Based on your last 30 days. Tap for the full report and coaching tips.</Text>
                  {week?.avgScore != null && (
                    <Chip label={`This week ${week.avgScore}`} tone="neutral" style={{ marginTop: 8, borderWidth: 1, borderColor: scoreColor(week.avgScore, t), backgroundColor: 'transparent' }} />
                  )}
                </View>
                <Ionicons name="chevron-forward" size={18} color={t.colors.textSubtle} />
              </View>
            ) : (
              <EmptyState
                compact
                icon="sparkles-outline"
                title="No safety score yet"
                body="After a few drives, get an AI read on your habits."
                action={<Button title="Open insights" variant="soft" onPress={() => navigation.navigate('Drives', { screen: 'DrivesHome', params: { tab: 'insights' } })} />}
              />
            )}
          </Card>
        </Section>

        <Section
          label="Recent drives"
          actions={
            drives && drives.length > 0 ? (
              <Text onPress={() => navigation.navigate('Drives', { screen: 'DrivesHome' })} style={[t.typography.caption, { color: t.colors.accent, fontWeight: '700' }]}>
                See all
              </Text>
            ) : null
          }
        >
          <Card padded={false}>
            {drives === null ? (
              <View style={{ padding: 16, gap: 12 }}>
                <Skeleton height={44} />
                <Skeleton height={44} />
                <Skeleton height={44} />
              </View>
            ) : drives.length === 0 ? (
              <EmptyState compact icon="car-outline" title="No drives yet" body="Your first drive will show up here with its score." />
            ) : (
              drives.slice(0, 3).map((d, i) => (
                <RecentDriveRow key={d.id} drive={d} unit={unit} first={i === 0} onPress={() => navigation.navigate('Drives', { screen: 'DriveDetail', params: { drive: serializeDrive(d) } })} />
              ))
            )}
          </Card>
        </Section>

        <Section label="Family">
          <Card padded={false}>
            {family ? (
              <ListRow
                first
                icon={family.emergencies > 0 ? 'alert-circle' : 'people'}
                iconColor={family.emergencies > 0 ? t.colors.danger : undefined}
                iconBg={family.emergencies > 0 ? t.colors.dangerFaint : undefined}
                title={family.name}
                subtitle={family.emergencies > 0 ? `${family.emergencies} member${family.emergencies === 1 ? '' : 's'} need help` : `${family.members} member${family.members === 1 ? '' : 's'} sharing location`}
                chevron
                onPress={() => navigation.navigate('Family')}
              />
            ) : (
              <ListRow first icon="people-outline" title="Set up family safety" subtitle="Share your location and send SOS alerts to the people who matter." chevron onPress={() => navigation.navigate('Family')} />
            )}
          </Card>
        </Section>
      </ScrollView>

      <Sheet visible={streakInfo} onClose={() => setStreakInfo(false)} eyebrow="Focus streak" title={`${streak} in a row`}>
        <Text style={[t.typography.body, { color: t.colors.textMuted, lineHeight: 22 }]}>
          Every focused drive adds one. Picking up the phone for more than 5 seconds, or a critical driver-monitoring alert, resets it to zero.
        </Text>
        <View style={{ height: 16 }} />
        <Button title="Got it" onPress={() => setStreakInfo(false)} />
      </Sheet>
    </Screen>
  );
}
