// InsightsPanel — the Insights tab of the Drives screen (was screens/AIScreen).
// Timeframe control, the distraction chart, focus and dynamics stats, and the
// entry point to the AI feedback screen.
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Dimensions } from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  Banner,
  Button,
  Card,
  Ring,
  Section,
  SegmentedTabs,
  StatCell,
  StatDivider,
  scoreColor,
  useTheme,
} from '../../theme';
import { summarizeDrives } from '../../utils/driveScore';
import { formatDistance, formatDuration, formatSpeed, toDate } from '../../utils/format';
import { MetricGroup } from './MetricGroup';

const { width } = Dimensions.get('window');
const TIMEFRAMES = [1, 7, 30];
const GRID_LINES = { 1: 4, 7: 1, 30: 5 };

function inRange(drive, timeframe) {
  const now = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - (timeframe - 1));
  const dt = toDate(drive.timestamp);
  return dt >= start && dt <= now;
}

function eyesOffSeconds(drive) {
  return Number(drive.eyesOffRoadSeconds ?? drive.monitoring?.eyesOffRoadSeconds) || 0;
}

// Bucket `valueOf(drive)` into hours (Day) or days (Week / Month).
function aggregateByTimeframe(drives, timeframe, valueOf) {
  const toLocalDayKey = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const now = new Date();
  const labels = [];
  const data = [];

  if (timeframe === 1) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    for (let h = 0; h < 24; h++) {
      const hour = new Date(start);
      hour.setHours(start.getHours() + h);
      const hourTotal = drives
        .filter((item) => {
          const dt = toDate(item.timestamp);
          return (
            dt.getFullYear() === hour.getFullYear() &&
            dt.getMonth() === hour.getMonth() &&
            dt.getDate() === hour.getDate() &&
            dt.getHours() === hour.getHours()
          );
        })
        .reduce((sum, item) => sum + valueOf(item), 0);
      data.push(hourTotal);
      if (h % 4 === 0) {
        const hr = hour.getHours();
        const hr12 = hr % 12 === 0 ? 12 : hr % 12;
        const ampm = hr < 12 ? 'AM' : 'PM';
        labels.push(`${hr12} ${ampm}`);
      } else {
        labels.push('');
      }
    }
    return { labels, data };
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - (timeframe - 1));

  const totalsByDay = {};
  for (const item of drives) {
    const dt = toDate(item.timestamp);
    if (dt < start || dt > now) continue;
    const key = toLocalDayKey(dt);
    totalsByDay[key] = (totalsByDay[key] || 0) + valueOf(item);
  }

  const labelInterval = timeframe <= 7 ? 1 : 5;
  for (let i = 0; i < timeframe; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = toLocalDayKey(day);
    const value = totalsByDay[key] !== undefined ? totalsByDay[key] : 0;
    data.push(value);
    const month = day.getMonth() + 1;
    const dayNum = day.getDate();
    labels.push(i % labelInterval === 0 ? `${month}/${dayNum}` : '');
  }

  return { labels, data };
}

export function aggregateDistractionsByTimeframe(drives, timeframe) {
  return aggregateByTimeframe(drives, timeframe, (item) => Number(item.distracted || 0));
}

function aggregateEyesOffByTimeframe(drives, timeframe) {
  return aggregateByTimeframe(drives, timeframe, (item) => Math.round(eyesOffSeconds(item)));
}

function normalizeInput(stats) {
  const { generatedAt, ...rest } = stats;
  return rest;
}

// The 30-day payload sent to the feedback model. Unchanged from AIScreen so the
// response cache written by earlier builds still matches.
function generateStatsJSON(drives) {
  let totalSpeedingMargin = 0;
  let totalSuddenAccels = 0;
  let totalSuddenStops = 0;
  let totalDistance = 0;
  let totalWeightedSpeed = 0;
  let totalDuration = 0;
  let totalSpeedingEvents = 0;
  let distractedCountVal = 0;

  const now = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - 29);

  const drivesToUse = drives.filter((drive) => {
    const dt = toDate(drive.timestamp);
    return dt >= start && dt <= now;
  });

  drivesToUse.forEach((drive) => {
    const duration = drive.duration || 0;
    totalWeightedSpeed += (drive.avgSpeed || 0) * duration;
    totalSpeedingMargin += (drive.avgSpeedingMargin || 0) * duration;
    totalSuddenAccels += drive.suddenAccelerations || 0;
    totalSuddenStops += drive.suddenStops || 0;
    totalDistance += drive.totalDistance || 0;
    totalDuration += duration;
    totalSpeedingEvents += drive.speedingEvents || 0;
    if (drive.distracted > 0) distractedCountVal += 1;
  });

  const totalDrives = drivesToUse.length;
  const undistractedCountVal = totalDrives - distractedCountVal;
  const percent =
    totalDrives > 0 ? Math.round((distractedCountVal / totalDrives) * 10000) / 100 : 0;

  return {
    totalPhoneDistractions: distractedCountVal,
    numberOfDistractedDrives: distractedCountVal,
    numberOfUndistractedDrives: undistractedCountVal,
    percentDistracted: percent,
    averageSpeedingMargin: totalDuration > 0 ? (totalSpeedingMargin / totalDuration).toFixed(1) : 0,
    averageSpeed: totalDuration > 0 ? (totalWeightedSpeed / totalDuration).toFixed(1) : 0,
    suddenStops: totalSuddenStops,
    suddenAccelerations: totalSuddenAccels,
    speedingEvents: totalSpeedingEvents,
    totalDistance: (totalDistance * 0.000621371).toFixed(1),
    totalDuration,
    generatedAt: new Date().toISOString(),
  };
}

function LegendDot({ color, label }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{label}</Text>
    </View>
  );
}

export function InsightsPanel({ drives = [], unit = 'mph', navigation }) {
  const t = useTheme();
  const [timeframeIndex, setTimeframeIndex] = useState(1);
  const [feedbackLabel, setFeedbackLabel] = useState('Get personalized feedback');
  const [notEnoughData, setNotEnoughData] = useState(false);

  const timeframe = TIMEFRAMES[timeframeIndex];
  const gridLines = GRID_LINES[timeframe];

  const scoped = useMemo(
    () => drives.filter((d) => inRange(d, timeframe)),
    [drives, timeframe]
  );

  const stats = useMemo(() => {
    let totalWeightedSpeed = 0;
    let totalSpeedingMargin = 0;
    let totalSuddenAccels = 0;
    let totalSuddenStops = 0;
    let totalDistance = 0;
    let totalDuration = 0;
    let distractedCount = 0;
    let totalSpeedingEvents = 0;

    scoped.forEach((drive) => {
      const duration = Number(drive.duration) || 0;
      totalWeightedSpeed += (Number(drive.avgSpeed) || 0) * duration;
      totalSpeedingMargin += (Number(drive.avgSpeedingMargin) || 0) * duration;
      totalSuddenAccels += Number(drive.suddenAccelerations) || 0;
      totalSuddenStops += Number(drive.suddenStops) || 0;
      totalDistance += Number(drive.totalDistance) || 0;
      totalDuration += duration;
      totalSpeedingEvents += Number(drive.speedingEvents) || 0;
      if ((Number(drive.distracted) || 0) > 0) distractedCount += 1;
    });

    const total = scoped.length;
    return {
      distractedCount,
      focusedCount: total - distractedCount,
      percentDistracted: total > 0 ? Math.round((distractedCount / total) * 100) : 0,
      avgSpeedingMargin: totalDuration > 0 ? totalSpeedingMargin / totalDuration : 0,
      avgSpeed: totalDuration > 0 ? totalWeightedSpeed / totalDuration : 0,
      suddenStops: totalSuddenStops,
      suddenAccelerations: totalSuddenAccels,
      speedingEvents: totalSpeedingEvents,
      totalDistance,
      totalDuration,
    };
  }, [scoped]);

  const avgScore = useMemo(() => summarizeDrives(scoped).avgScore, [scoped]);
  const hasMonitoring = useMemo(
    () => scoped.some((d) => d.monitoring && d.monitoring.enabled),
    [scoped]
  );

  const { labels, data } = useMemo(
    () => aggregateDistractionsByTimeframe(drives, timeframe),
    [drives, timeframe]
  );
  const eyesOff = useMemo(
    () => (hasMonitoring ? aggregateEyesOffByTimeframe(drives, timeframe).data : null),
    [drives, timeframe, hasMonitoring]
  );

  const datasets = eyesOff
    ? [
        { data, color: () => t.colors.accent, strokeWidth: 2 },
        { data: eyesOff, color: () => t.colors.info, strokeWidth: 2 },
      ]
    : [{ data, color: () => t.colors.accent, strokeWidth: 2 }];

  const peak = Math.max(1, ...data, ...(eyesOff || [0]));
  const segments = Math.max(1, Math.min(Math.round(peak), 6));

  // "View" vs "Get" — a cached response for exactly this payload already exists.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const normalizedInput = normalizeInput(generateStatsJSON(drives));
        let cache = [];
        try {
          const storedCache = await AsyncStorage.getItem('feedbackCache');
          if (storedCache) cache = JSON.parse(storedCache);
        } catch {}
        const match = cache.find(
          (entry) => JSON.stringify(entry.input) === JSON.stringify(normalizedInput)
        );
        if (!cancelled) {
          setFeedbackLabel(match ? 'View personalized feedback' : 'Get personalized feedback');
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [drives])
  );

  const onFeedbackPress = () => {
    const statsJSON = generateStatsJSON(drives);
    const totalDistance = Number(statsJSON?.totalDistance || 0);
    const duration = Number(statsJSON?.totalDuration || 0);
    if (totalDistance < 10 || duration < 500) {
      setNotEnoughData(true);
      return;
    }
    setNotEnoughData(false);
    navigation?.navigate('AIFeedback', { statsJSON });
  };

  return (
    <View>
      <Section label="Timeframe">
        <SegmentedTabs
          values={['Day', 'Week', 'Month']}
          selectedIndex={timeframeIndex}
          onChange={setTimeframeIndex}
        />
      </Section>

      <Section label="Phone distractions">
        <Card>
          {labels.length > 0 ? (
            <>
              <LineChart
                data={{ labels, datasets }}
                width={width - 80}
                height={220}
                fromZero
                yAxisInterval={gridLines}
                segments={segments}
                chartConfig={{
                  backgroundGradientFrom: t.colors.surface,
                  backgroundGradientTo: t.colors.surface,
                  decimalPlaces: 0,
                  color: () => t.colors.accent,
                  labelColor: () => t.colors.textMuted,
                  style: { borderRadius: t.radius.md },
                  propsForDots: ({ value }) => ({
                    r: value !== undefined && value !== null ? '4' : '0',
                    strokeWidth: value !== undefined && value !== null ? '2' : '0',
                    stroke: t.colors.accent,
                    fill: t.colors.surface,
                  }),
                  propsForBackgroundLines: { stroke: t.colors.divider },
                }}
                bezier
                style={{ marginVertical: 4, borderRadius: t.radius.md, paddingRight: 0 }}
              />
              {!!eyesOff && (
                <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, paddingLeft: 4 }}>
                  <LegendDot color={t.colors.accent} label="Phone pickups" />
                  <LegendDot color={t.colors.info} label="Eyes off road (s)" />
                </View>
              )}
            </>
          ) : (
            <Text style={[t.typography.caption, { color: t.colors.textMuted, textAlign: 'center' }]}>
              No data for selected timeframe.
            </Text>
          )}
        </Card>
      </Section>

      <Section label="Focus">
        <Card>
          <View style={{ flexDirection: 'row' }}>
            <StatCell label="Distracted" value={String(stats.distractedCount)} size="sm" />
            <StatDivider />
            <StatCell
              label="Focused"
              value={String(stats.focusedCount)}
              size="sm"
              color={t.colors.accent}
            />
            <StatDivider />
            <StatCell
              label="Distracted %"
              value={`${stats.percentDistracted}%`}
              size="sm"
              color={scoreColor(100 - stats.percentDistracted, t)}
            />
          </View>
        </Card>
      </Section>

      {avgScore !== null && (
        <Section label="Average score">
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
              <Ring value={avgScore} size={92} />
              <View style={{ flex: 1 }}>
                <Text style={[t.typography.subheading, { color: t.colors.text }]}>
                  Across {scoped.length} drive{scoped.length === 1 ? '' : 's'}
                </Text>
                <Text
                  style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 4 }]}
                >
                  Focus, speed and smoothness combined into one score per drive.
                </Text>
              </View>
            </View>
          </Card>
        </Section>
      )}

      <Section label="Driving dynamics">
        <MetricGroup
          rows={[
            { label: 'Speeding events', value: String(stats.speedingEvents) },
            {
              label: 'Avg speeding margin',
              value: formatSpeed(stats.avgSpeedingMargin, unit),
            },
            { label: 'Avg speed', value: formatSpeed(stats.avgSpeed, unit) },
            { label: 'Hard brakes', value: String(stats.suddenStops) },
            { label: 'Hard accelerations', value: String(stats.suddenAccelerations) },
            { label: 'Distance', value: formatDistance(stats.totalDistance, unit) },
            { label: 'Time driving', value: formatDuration(stats.totalDuration) },
          ]}
        />
      </Section>

      <Section>
        {notEnoughData && (
          <Banner
            tone="info"
            title="Not enough data yet"
            body="Feedback needs at least 10 miles and about 10 minutes of driving in the last 30 days."
            style={{ marginBottom: 12 }}
          />
        )}
        <Button
          title={feedbackLabel}
          onPress={onFeedbackPress}
          icon={<Ionicons name="sparkles" size={18} color={t.colors.accentText} />}
        />
      </Section>
    </View>
  );
}

export default InsightsPanel;
