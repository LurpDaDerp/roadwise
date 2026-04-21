import React, { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  ScrollView,
  Alert,
  Pressable,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChanged } from 'firebase/auth';

import { auth } from '../utils/firebase';
import { getAllDriveMetrics } from '../utils/firestore';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  AutoFitText,
  useTheme,
} from '../theme';

const { width } = Dimensions.get('window');

function aggregateDistractionsByTimeframe(drives, timeframe) {
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
          const dt = item.timestamp?.toDate ? item.timestamp.toDate() : new Date(item.timestamp);
          return (
            dt.getFullYear() === hour.getFullYear() &&
            dt.getMonth() === hour.getMonth() &&
            dt.getDate() === hour.getDate() &&
            dt.getHours() === hour.getHours()
          );
        })
        .reduce((sum, item) => sum + Number(item.distracted || 0), 0);
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
    const dt = item.timestamp?.toDate ? item.timestamp.toDate() : new Date(item.timestamp);
    if (dt < start || dt > now) continue;
    const key = toLocalDayKey(dt);
    totalsByDay[key] = (totalsByDay[key] || 0) + Number(item.distracted || 0);
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

function normalizeInput(stats) {
  const { generatedAt, ...rest } = stats;
  return rest;
}

function formatTotalDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0 && remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  } else if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}

function interpolateColor(percent) {
  const p = Math.min(Math.max(percent, 0), 100) / 100;
  const start = { r: 0, g: 200, b: 120 };
  const mid = { r: 240, g: 180, b: 60 };
  const end = { r: 230, g: 80, b: 80 };
  let r, g, b;
  if (p < 0.5) {
    const k = p / 0.5;
    r = Math.round(start.r + (mid.r - start.r) * k);
    g = Math.round(start.g + (mid.g - start.g) * k);
    b = Math.round(start.b + (mid.b - start.b) * k);
  } else {
    const k = (p - 0.5) / 0.5;
    r = Math.round(mid.r + (end.r - mid.r) * k);
    g = Math.round(mid.g + (end.g - mid.g) * k);
    b = Math.round(mid.b + (end.b - mid.b) * k);
  }
  return `rgb(${r},${g},${b})`;
}

export default function AIScreen({ navigation }) {
  const t = useTheme();

  const [timeframe, setTimeframe] = useState(7);
  const [gridLines, setGridLines] = useState(7);
  const [drives, setDrives] = useState([]);
  const [uid, setUid] = useState(null);
  const [stats, setStats] = useState({
    avgSpeedingMargin: 0,
    suddenAccelerations: 0,
    suddenStops: 0,
    avgSpeed: 0,
    totalDistance: 0,
    totalDuration: '0m',
    speedingEvents: 0,
  });

  const [unit, setUnit] = useState('mph');
  const metersToMiles = (m) => m * 0.000621371;

  const [feedbackLabel, setFeedbackLabel] = useState('Get personalized feedback');
  const [percentDistracted, setPercentDistracted] = useState(0);
  const [distractedCount, setDistractedCount] = useState(0);
  const [undistractedCount, setUndistractedCount] = useState(0);

  const percentColor = interpolateColor(percentDistracted);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const storedUnit = await AsyncStorage.getItem('@speedUnit');
          if (storedUnit === 'mph' || storedUnit === 'kph') setUnit(storedUnit);
        } catch {}
      })();
    }, [])
  );

  useLayoutEffect(() => {
    navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
    return () => {
      navigation.getParent()?.setOptions({ tabBarStyle: { display: 'flex' } });
    };
  }, [navigation]);

  const generateStatsJSON = () => {
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
      const dt = drive.timestamp?.toDate ? drive.timestamp.toDate() : new Date(drive.timestamp);
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
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) setUid(user.uid);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!uid) return;
    const fetchMetrics = async () => {
      const metrics = await getAllDriveMetrics(uid);
      setDrives(metrics);

      if (!metrics || metrics.length === 0) {
        setStats({
          avgSpeedingMargin: 0,
          suddenAccelerations: 0,
          suddenStops: 0,
          avgSpeed: 0,
          totalDistance: 0,
          totalDuration: '0m',
          speedingEvents: 0,
        });
        setDistractedCount(0);
        setUndistractedCount(0);
        setPercentDistracted(0);
        return;
      }

      const now = new Date();
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(now.getDate() - (timeframe - 1));

      const drivesToUse = metrics.filter((drive) => {
        const dt = drive.timestamp?.toDate ? drive.timestamp.toDate() : new Date(drive.timestamp);
        return dt >= start && dt <= now;
      });

      let totalWeightedSpeed = 0;
      let totalSpeedingMargin = 0;
      let totalSuddenAccels = 0;
      let totalSuddenStops = 0;
      let totalDistance = 0;
      let totalDuration = 0;
      let distractedCountVal = 0;
      let totalSpeedingEvents = 0;

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
      totalDistance = metersToMiles(totalDistance);

      setStats({
        avgSpeedingMargin: totalDuration > 0 ? (totalSpeedingMargin / totalDuration).toFixed(1) : 0,
        suddenAccelerations: totalSuddenAccels,
        suddenStops: totalSuddenStops,
        avgSpeed: totalDuration > 0 ? (totalWeightedSpeed / totalDuration).toFixed(1) : 0,
        totalDistance: totalDistance.toFixed(1),
        totalDuration: formatTotalDuration(totalDuration),
        speedingEvents: totalSpeedingEvents,
      });

      setDistractedCount(distractedCountVal);
      setUndistractedCount(undistractedCountVal);
      setPercentDistracted(percent);
    };

    fetchMetrics();
  }, [uid, timeframe]);

  useFocusEffect(
    useCallback(() => {
      const fetchFeedbackLabel = async () => {
        const normalizedInput = normalizeInput(generateStatsJSON());
        let cache = [];
        try {
          const storedCache = await AsyncStorage.getItem('feedbackCache');
          if (storedCache) cache = JSON.parse(storedCache);
        } catch {}
        const match = cache.find(
          (entry) => JSON.stringify(entry.input) === JSON.stringify(normalizedInput)
        );
        setFeedbackLabel(match ? 'View personalized feedback' : 'Get personalized feedback');
      };
      fetchFeedbackLabel();
    }, [drives, timeframe])
  );

  const { labels, data } = aggregateDistractionsByTimeframe(drives, timeframe);
  const maxDistractions = data.length > 0 ? Math.max(...data) : 1;
  const segments = Math.max(1, Math.min(maxDistractions, 6));

  const onFeedbackPress = () => {
    const statsJSON = generateStatsJSON();
    const totalDistance = Number(statsJSON?.totalDistance || 0);
    const duration = Number(statsJSON?.totalDuration || 0);
    if (totalDistance < 10 || duration < 500) {
      Alert.alert('Not enough data', 'Please complete a few more drives to get feedback.');
      return;
    }
    navigation.navigate('AIFeedback', { statsJSON });
  };

  const unitLabel = unit === 'kph' ? 'kph' : 'mph';

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        <ScreenHeader
          align="right"
          eyebrow="Insights"
          title="Driver report"
          subtitle="Patterns from your recent drives."
        />

        <Section>
          <Button
            title={feedbackLabel}
            onPress={onFeedbackPress}
            icon={<Ionicons name="sparkles" size={18} color={t.colors.accentText} />}
          />
        </Section>

        <Section label="Timeframe">
          <Card>
            <SegmentedControl
              values={['1D', '7D', '30D']}
              selectedIndex={timeframe === 1 ? 0 : timeframe === 7 ? 1 : 2}
              onChange={(event) => {
                const index = event.nativeEvent.selectedSegmentIndex;
                if (index === 0) {
                  setTimeframe(1);
                  setGridLines(4);
                } else if (index === 1) {
                  setTimeframe(7);
                  setGridLines(1);
                } else {
                  setTimeframe(30);
                  setGridLines(5);
                }
              }}
              appearance={t.isDark ? 'dark' : 'light'}
              tintColor={t.colors.accent}
              style={{ height: 40 }}
            />
          </Card>
        </Section>

        <Section label="Phone distractions">
          <Card>
            {labels.length > 0 ? (
              <LineChart
                data={{ labels, datasets: [{ data }] }}
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
                style={{
                  marginVertical: 4,
                  borderRadius: t.radius.md,
                  paddingRight: 0,
                }}
              />
            ) : (
              <Text
                style={[t.typography.caption, { color: t.colors.textMuted, textAlign: 'center' }]}
              >
                No data for selected timeframe.
              </Text>
            )}
          </Card>
        </Section>

        <Section label="Focus">
          <Card>
            <View style={{ flexDirection: 'row' }}>
              <StatCell t={t} label="Distracted drives" value={String(distractedCount)} />
              <Div t={t} />
              <StatCell
                t={t}
                label="Focused drives"
                value={String(undistractedCount)}
                color={t.colors.accent}
              />
              <Div t={t} />
              <StatCell
                t={t}
                label="Distracted %"
                value={`${percentDistracted}%`}
                color={percentColor}
              />
            </View>
          </Card>
        </Section>

        <Section label="Driving dynamics">
          <Card padded={false}>
            <MetricRow t={t} label="Speeding events" value={stats.speedingEvents} first />
            <MetricRow
              t={t}
              label="Avg speeding margin"
              value={`${stats.avgSpeedingMargin} ${unitLabel}`}
            />
            <MetricRow t={t} label="Avg speed" value={`${stats.avgSpeed} ${unitLabel}`} />
            <MetricRow t={t} label="Sudden stops" value={stats.suddenStops} />
            <MetricRow t={t} label="Sudden accelerations" value={stats.suddenAccelerations} />
            <MetricRow t={t} label="Total distance" value={`${stats.totalDistance} mi`} />
            <MetricRow t={t} label="Total time driving" value={stats.totalDuration} />
          </Card>
        </Section>

        <Section>
          <Button
            title="View all drives"
            variant="ghost"
            icon={<Ionicons name="list-outline" size={18} color={t.colors.text} />}
            onPress={() => navigation.navigate('MyDrives')}
          />
        </Section>
      </ScrollView>
    </Screen>
  );
}

function StatCell({ t, label, value, color }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
      <Text
        style={[
          t.typography.micro,
          {
            color: t.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 1.1,
            marginBottom: 6,
            textAlign: 'center',
          },
        ]}
      >
        {label}
      </Text>
      <AutoFitText style={[t.typography.numeric, { color: color || t.colors.text }]}>{value}</AutoFitText>
    </View>
  );
}

function Div({ t }) {
  return (
    <View
      style={{
        width: StyleSheet.hairlineWidth,
        backgroundColor: t.colors.divider,
        marginVertical: 4,
      }}
    />
  );
}

function MetricRow({ t, label, value, first }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
      }}
    >
      <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{label}</Text>
      <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>{String(value)}</Text>
    </View>
  );
}
