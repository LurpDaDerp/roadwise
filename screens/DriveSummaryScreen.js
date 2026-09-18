// DriveSummaryScreen — what happened, points earned, what to improve.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ConfettiCannon from 'react-native-confetti-cannon';

import { Screen, Section, Card, Button, Chip, Ring, scoreColor, StatCell, StatDivider, ProgressBar, KeyValueRow, Banner, useTheme, useCountUp } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { MonitoringSummaryCard } from '../components/monitoring/MonitoringSummaryCard';
import { getDriveTips, scoreLabel } from '../utils/driveScore';
import { formatDuration, formatDistance, formatSpeed } from '../utils/format';

const { width } = Dimensions.get('window');

function MiniBar({ label, value, t }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{label}</Text>
        <Text style={[t.typography.caption, { color: scoreColor(value, t), fontWeight: '700' }]}>{Math.round(value)}</Text>
      </View>
      <ProgressBar value={value / 100} tone={value >= 75 ? 'accent' : value >= 50 ? 'warning' : 'danger'} height={6} />
    </View>
  );
}

export default function DriveSummaryScreen({ navigation, route }) {
  const t = useTheme();
  const { settings } = useSettings();
  const summary = route.params?.summary || {};
  const unit = summary.unit || settings.speedUnit;
  const confettiRef = useRef(null);
  const [confetti, setConfetti] = useState(false);

  const focused = !summary.wasDistracted;
  const earned = Number(summary.points) || 0;
  const shownPoints = useCountUp(earned, 700);
  const tips = useMemo(() => getDriveTips(summary, 3), [summary]);
  const breakdown = summary.scoreBreakdown || { focus: 0, speed: 0, smoothness: 0 };
  const score = Number(summary.score) || 0;

  useEffect(() => {
    if (focused && earned > 0) {
      const id = setTimeout(() => setConfetti(true), 250);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [focused, earned]);
  useEffect(() => {
    if (confetti && confettiRef.current) confettiRef.current.start();
  }, [confetti]);

  const goHome = () => navigation.navigate('Main', { screen: 'Home' });
  const goHistory = () => navigation.navigate('Main', { screen: 'Drives', params: { screen: 'DrivesHome' } });

  const streakLine = summary.streakChanged
    ? focused
      ? `Streak ${summary.previousStreak} → ${summary.newStreak}`
      : `Streak reset (was ${summary.previousStreak})`
    : 'Streak unchanged';

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ alignItems: 'center', marginTop: 8, marginBottom: 20 }}>
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: focused ? t.colors.accentFaint : t.colors.dangerFaint,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 14,
            }}
          >
            <Ionicons name={focused ? 'shield-checkmark' : 'shield-half'} size={38} color={focused ? t.colors.accent : t.colors.danger} />
          </View>
          <Text style={[t.typography.micro, { color: t.colors.accent, marginBottom: 6 }]}>Drive complete</Text>
          <Text style={[t.typography.title, { color: t.colors.text, textAlign: 'center' }]}>{focused ? 'Focused drive' : 'Distracted drive'}</Text>
          {!focused && Array.isArray(summary.distractionReasons) && summary.distractionReasons.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 10 }}>
              {summary.distractionReasons.map((r) => (
                <Chip key={r} label={r} tone="danger" />
              ))}
            </View>
          )}
          {summary.autoEnded && (
            <Banner tone="warning" title="Ended automatically" body="You were away from RoadWise for 2 minutes." style={{ marginTop: 14, alignSelf: 'stretch' }} />
          )}
          {!summary.saved && earned === 0 && (
            <Banner tone="neutral" icon="information-circle-outline" title="Not saved" body="Drives with no points are not added to your history." style={{ marginTop: 14, alignSelf: 'stretch' }} />
          )}
        </View>

        <Section>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={[t.typography.micro, { color: t.colors.textMuted, marginBottom: 4 }]}>Points earned</Text>
                <Text style={[t.typography.numeric, { color: t.colors.accent }]}>+{shownPoints.toLocaleString()}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <Ionicons name="flame" size={16} color={focused && summary.streakChanged ? t.colors.warning : t.colors.textSubtle} />
                  <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{streakLine}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Ring value={score} size={104} label={scoreLabel(score).toUpperCase()} />
              </View>
            </View>
            <View style={{ marginTop: 16 }}>
              <MiniBar label="Focus" value={breakdown.focus} t={t} />
              <MiniBar label="Speed" value={breakdown.speed} t={t} />
              <MiniBar label="Smoothness" value={breakdown.smoothness} t={t} />
            </View>
          </Card>
        </Section>

        <Section label="Trip">
          <Card>
            <View style={{ flexDirection: 'row' }}>
              <StatCell label="Time" value={formatDuration(summary.duration)} size="sm" />
              <StatDivider />
              <StatCell label="Distance" value={formatDistance(summary.totalDistance, unit)} size="sm" />
              <StatDivider />
              <StatCell label="Avg speed" value={formatSpeed(summary.avgSpeed, unit)} size="sm" />
            </View>
          </Card>
          <Card padded={false} style={{ marginTop: 12 }}>
            <KeyValueRow first label="Top speed" value={formatSpeed(summary.maxSpeed, unit)} />
            <KeyValueRow label="Speeding events" value={summary.speedingEvents ?? 0} tone={(summary.speedingEvents ?? 0) > 0 ? 'warning' : undefined} />
            <KeyValueRow label="Hard brakes" value={summary.suddenStops ?? 0} tone={(summary.suddenStops ?? 0) > 0 ? 'warning' : undefined} />
            <KeyValueRow label="Hard accelerations" value={summary.suddenAccelerations ?? 0} tone={(summary.suddenAccelerations ?? 0) > 0 ? 'warning' : undefined} />
            <KeyValueRow label="Phone pickups" value={summary.distracted ?? 0} tone={(summary.distracted ?? 0) > 0 ? 'danger' : undefined} />
            {(summary.phoneUsageTime ?? 0) > 0 && <KeyValueRow label="Time on phone" value={`${Math.round(summary.phoneUsageTime)} s`} tone="danger" />}
          </Card>
        </Section>

        {summary.monitoring && (
          <Section label="Driver monitoring">
            <MonitoringSummaryCard monitoring={summary.monitoring} />
          </Section>
        )}

        <Section label="What to improve">
          <Card padded={false}>
            {tips.map((tip, i) => (
              <View
                key={`${tip.title}-${i}`}
                style={{ flexDirection: 'row', paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.colors.divider, gap: 12 }}
              >
                <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: t.colors.accentFaint, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={tip.icon} size={16} color={t.colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>{tip.title}</Text>
                  <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2, lineHeight: 18 }]}>{tip.body}</Text>
                </View>
              </View>
            ))}
          </Card>
        </Section>

        <Button title="Done" onPress={goHome} icon={<Ionicons name="home" size={18} color={t.colors.accentText} />} />
        <View style={{ height: 10 }} />
        <Button title="View drive history" variant="ghost" onPress={goHistory} />
      </ScrollView>

      {confetti && (
        <ConfettiCannon count={90} origin={{ x: width / 2, y: -20 }} explosionSpeed={500} fallSpeed={1800} fadeOut autoStart={false} ref={confettiRef} />
      )}
    </Screen>
  );
}
