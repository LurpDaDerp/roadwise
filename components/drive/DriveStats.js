// DriveStats — one compact row under the speed: points (with the focus state underneath) and
// the road conditions. Replaces the separate PointsCard and ConditionsStrip, whose 48-pt points
// number competed with the speed for the driver's glance.
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, View, Text, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '../../theme';
import { getWeatherInfo, roadScoreToTone } from '../../utils/driveConditions';

// Open-Meteo is queried in Fahrenheit (utils/weather.js); show Celsius to km/h drivers.
function temperatureLabel(fahrenheit, unit) {
  if (!Number.isFinite(fahrenheit)) return null;
  return unit === 'kph' ? `${Math.round(((fahrenheit - 32) * 5) / 9)}°C` : `${Math.round(fahrenheit)}°F`;
}

const PointsCell = React.memo(function PointsCell({ points, label, state, pausedReason }) {
  const t = useTheme();
  const bump = useRef(new Animated.Value(1)).current;
  const prev = useRef(points);
  useEffect(() => {
    if (points > prev.current) {
      bump.setValue(1.15);
      Animated.spring(bump, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();
    }
    prev.current = points;
  }, [points, bump]);

  const s = useMemo(() => {
    const states = {
      focused: { icon: 'shield-checkmark', color: t.colors.accent, text: 'Focused' },
      paused: { icon: 'pause-circle', color: t.colors.warning, text: pausedReason || 'Paused' },
      distracted: { icon: 'shield-half', color: t.colors.danger, text: 'Streak lost' },
      idle: { icon: 'shield-outline', color: t.colors.textSubtle, text: 'Start moving' },
    };
    return states[state] || states.focused;
  }, [state, pausedReason, t.colors]);

  return (
    <View style={styles.cell} accessibilityLabel={`${label}: ${points}. ${s.text}`}>
      <Text style={[t.typography.micro, { color: t.colors.textMuted }]}>{label}</Text>
      <Animated.Text
        style={[styles.value, { color: state === 'distracted' ? t.colors.danger : t.colors.text, transform: [{ scale: bump }] }]}
        numberOfLines={1}
      >
        {Number(points).toLocaleString()}
      </Animated.Text>
      <View style={styles.status}>
        <Ionicons name={s.icon} size={14} color={s.color} />
        <Text style={[styles.statusText, { color: s.color }]} numberOfLines={1}>{s.text}</Text>
      </View>
    </View>
  );
});

const ConditionsCell = React.memo(function ConditionsCell({ weather, roadSummary, unit }) {
  const t = useTheme();
  const info = weather?.current ? getWeatherInfo(weather.current.weathercode) : null;
  const tone = roadScoreToTone(roadSummary?.score);
  const toneColor = { success: t.colors.accent, warning: t.colors.warning, danger: t.colors.danger, neutral: t.colors.textMuted }[tone];
  const temp = temperatureLabel(weather?.current?.temperature_2m, unit);
  const summary = roadSummary?.summary || (info ? info.label : 'Reading conditions');
  return (
    <View style={styles.cell} accessibilityLabel={`Conditions: ${summary}${temp ? `, ${temp}` : ''}`}>
      <Text style={[t.typography.micro, { color: t.colors.textMuted }]}>Road</Text>
      <View style={styles.row}>
        <MaterialCommunityIcons name={info ? info.icon : 'weather-cloudy'} size={26} color={t.colors.textMuted} />
        <Text style={[styles.value, { color: t.colors.text }]} numberOfLines={1}>{temp || '--'}</Text>
      </View>
      <View style={styles.status}>
        <View style={[styles.dot, { backgroundColor: toneColor }]} />
        <Text style={[styles.statusText, { color: t.colors.textMuted }]} numberOfLines={1}>{summary}</Text>
      </View>
    </View>
  );
});

export const DriveStats = React.memo(function DriveStats({ points, pointsLabel, pointsState, pausedReason, weather, roadSummary, unit }) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.strip,
        { backgroundColor: t.colors.surface, borderColor: t.colors.border, borderRadius: t.radius.lg },
      ]}
    >
      <PointsCell points={points} label={pointsLabel} state={pointsState} pausedReason={pausedReason} />
      <View style={[styles.divider, { backgroundColor: t.colors.divider }]} />
      <ConditionsCell weather={weather} roadSummary={roadSummary} unit={unit} />
    </View>
  );
});

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14 },
  cell: { flex: 1, paddingHorizontal: 18, gap: 2 },
  divider: { width: StyleSheet.hairlineWidth, marginVertical: 4 },
  value: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusText: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

export default DriveStats;
