// ConditionsStrip — weather icon, temperature and a 3–6 word road summary.
// Replaces the old six-number weather panel: one line, colour-coded.
import React from 'react';
import { View, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, Card } from '../../theme';
import { getWeatherInfo, roadScoreToTone, roadScoreIcon } from '../../utils/driveConditions';

export function ConditionsStrip({ weather, roadSummary }) {
  const t = useTheme();
  const info = weather?.current ? getWeatherInfo(weather.current.weathercode) : null;
  const tone = roadScoreToTone(roadSummary?.score);
  const toneColor = { success: t.colors.accent, warning: t.colors.warning, danger: t.colors.danger, neutral: t.colors.textMuted }[tone];
  const summary = roadSummary?.summary || (info ? info.label : 'Reading conditions…');
  return (
    <Card padded={false} style={{ paddingVertical: 12, paddingHorizontal: 16, borderLeftWidth: 4, borderLeftColor: toneColor }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.colors.accentFaint, alignItems: 'center', justifyContent: 'center' }}>
          <MaterialCommunityIcons name={info ? info.icon : 'weather-cloudy'} size={24} color={t.colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 }} numberOfLines={1}>
            {summary}
          </Text>
          <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 1 }]} numberOfLines={1}>
            {info ? `${info.label} · ${Math.round(weather.current.temperature_2m)}°F` : 'Waiting for location'}
          </Text>
        </View>
        <MaterialCommunityIcons name={roadScoreIcon(roadSummary?.score)} size={22} color={toneColor} />
      </View>
    </Card>
  );
}

export default ConditionsStrip;
