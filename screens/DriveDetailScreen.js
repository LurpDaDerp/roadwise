// DriveDetailScreen — everything recorded for one drive. Old records only carry
// the original eleven fields, so every optional row is dropped when missing.
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View, Text } from 'react-native';

import {
  Screen,
  ScreenHeader,
  Section,
  Card,
  Chip,
  EmptyState,
  Skeleton,
  useTheme,
} from '../theme';
import { MonitoringSummaryCard } from '../components/monitoring';
import { MetricGroup, ScoreRing, TipsList, isDistractedDrive } from '../components/drives';
import { useAuthContext } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { getUserDrives } from '../utils/firestore';
import { getDriveTips, scoreDrive } from '../utils/driveScore';
import {
  formatDateTime,
  formatDistance,
  formatDuration,
  formatSpeed,
} from '../utils/format';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v) || 0);

export default function DriveDetailScreen({ route }) {
  const t = useTheme();
  const { uid } = useAuthContext();
  const { settings } = useSettings();

  const paramDrive = route?.params?.drive || null;
  const driveId = route?.params?.driveId || null;
  const [drive, setDrive] = useState(paramDrive);
  const [loading, setLoading] = useState(!paramDrive && !!driveId);

  useEffect(() => {
    if (paramDrive || !driveId || !uid) return undefined;
    let alive = true;
    (async () => {
      const all = await getUserDrives(uid);
      if (!alive) return;
      setDrive(all.find((d) => d.id === driveId) || null);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [paramDrive, driveId, uid]);

  const computed = useMemo(() => (drive ? scoreDrive(drive) : null), [drive]);
  const tips = useMemo(() => (drive ? getDriveTips(drive, 3) : []), [drive]);

  if (loading) {
    return (
      <Screen hasHeader>
        <View style={{ gap: 16 }}>
          <Skeleton width="45%" height={14} />
          <Skeleton width="70%" height={26} />
          <Skeleton width="100%" height={140} radius={20} />
          <Skeleton width="100%" height={180} radius={20} />
        </View>
      </Screen>
    );
  }

  if (!drive) {
    return (
      <Screen hasHeader>
        <Card>
          <EmptyState
            icon="car-outline"
            title="Drive not found"
            body="This drive is no longer in your history."
          />
        </Card>
      </Screen>
    );
  }

  const unit = drive.unit === 'mph' || drive.unit === 'kph' ? drive.unit : settings?.speedUnit || 'mph';
  const distracted = isDistractedDrive(drive);
  const score = typeof drive.score === 'number' ? drive.score : computed.score;
  const breakdown = drive.scoreBreakdown || computed.breakdown;
  const reasons = Array.isArray(drive.distractionReasons) ? drive.distractionReasons : [];
  const monitoring = drive.monitoring || null;
  const weather = drive.weather || null;

  const phoneSeconds = num(drive.phoneUsageTime);
  const maxSpeed = num(drive.maxSpeed);
  const margin = num(drive.avgSpeedingMargin);
  const eyesOff =
    monitoring && monitoring.enabled ? Math.round(Number(monitoring.eyesOffRoadSeconds) || 0) : null;

  return (
    <Screen hasHeader>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <ScreenHeader
          eyebrow={formatDateTime(drive.timestamp)}
          title={distracted ? 'Distracted drive' : 'Focused drive'}
        />

        {reasons.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            {reasons.map((reason, i) => (
              <Chip key={`${reason}-${i}`} label={reason} tone="danger" icon="alert-circle-outline" />
            ))}
          </View>
        )}

        <Section label="Score">
          <Card>
            <ScoreRing score={score} breakdown={breakdown} />
          </Card>
        </Section>

        <Section label="Focus">
          <MetricGroup
            rows={[
              { label: 'Phone pickups', value: String(num(drive.distracted) ?? 0) },
              phoneSeconds === null
                ? null
                : { label: 'Seconds on phone', value: `${Math.round(phoneSeconds)} s` },
              eyesOff === null ? null : { label: 'Eyes off road', value: `${eyesOff} s` },
            ]}
          />
        </Section>

        <Section label="Speed">
          <MetricGroup
            rows={[
              { label: 'Average speed', value: formatSpeed(drive.avgSpeed, unit) },
              maxSpeed === null ? null : { label: 'Top speed', value: formatSpeed(maxSpeed, unit) },
              { label: 'Speeding events', value: String(num(drive.speedingEvents) ?? 0) },
              margin === null
                ? null
                : { label: 'Avg over the limit', value: formatSpeed(margin, unit) },
            ]}
          />
        </Section>

        <Section label="Smoothness">
          <MetricGroup
            rows={[
              { label: 'Hard brakes', value: String(num(drive.suddenStops) ?? 0) },
              { label: 'Hard accelerations', value: String(num(drive.suddenAccelerations) ?? 0) },
            ]}
          />
        </Section>

        <Section label="Trip">
          <MetricGroup
            rows={[
              { label: 'Duration', value: formatDuration(drive.duration) },
              { label: 'Distance', value: formatDistance(drive.totalDistance, unit) },
              { label: 'Points', value: `+${num(drive.points) ?? 0}`, accent: true },
              drive.autoEnded ? { label: 'Ended automatically', value: 'Yes' } : null,
            ]}
          />
        </Section>

        {!!monitoring && (
          <Section label="Driver monitoring">
            <MonitoringSummaryCard monitoring={monitoring} />
          </Section>
        )}

        {!!weather && (
          <Section label="Conditions">
            <MetricGroup
              rows={[
                weather.summary ? { label: 'Road summary', value: weather.summary } : null,
                weather.temperature === null || weather.temperature === undefined
                  ? null
                  : { label: 'Temperature', value: `${Math.round(Number(weather.temperature))}°` },
                weather.roadScore === null || weather.roadScore === undefined
                  ? null
                  : { label: 'Road score', value: `${Math.round(Number(weather.roadScore))} / 5` },
              ]}
            />
          </Section>
        )}

        {tips.length > 0 && (
          <Section label="What to improve">
            <TipsList tips={tips} />
          </Section>
        )}

        <Text style={[t.typography.caption, { color: t.colors.textSubtle, textAlign: 'center' }]}>
          Scores are computed on this device from the drive record.
        </Text>
      </ScrollView>
    </Screen>
  );
}
