// ScoreRing — the per-drive score ring plus its three sub-scores.
// Shared by DriveSummary, DriveDetail and the Insights panel.
import React from 'react';
import { View, Text } from 'react-native';
import { ProgressBar, Ring, scoreColor, useTheme } from '../../theme';
import { scoreLabel } from '../../utils/driveScore';

const SUBS = [
  { key: 'focus', label: 'Focus' },
  { key: 'speed', label: 'Speed' },
  { key: 'smoothness', label: 'Smoothness' },
];

function barTone(value) {
  const v = Number(value) || 0;
  if (v >= 75) return 'accent';
  if (v >= 50) return 'warning';
  return 'danger';
}

export function ScoreRing({ score = 0, breakdown, size = 104, showLabel = true, style }) {
  const t = useTheme();
  const total = Math.max(0, Math.min(100, Number(score) || 0));
  const color = scoreColor(total, t);
  const parts = breakdown || {};

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 18 }, style]}>
      <Ring value={total} size={size} stroke={Math.max(7, Math.round(size * 0.09))} color={color} />
      <View style={{ flex: 1, gap: 10 }}>
        {showLabel && (
          <Text style={[t.typography.subheading, { color }]}>{scoreLabel(total)}</Text>
        )}
        {SUBS.map(({ key, label }) => {
          const value = Math.max(0, Math.min(100, Number(parts[key]) || 0));
          return (
            <View key={key}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 4,
                }}
              >
                <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{label}</Text>
                <Text
                  style={[t.typography.caption, { color: t.colors.text, fontWeight: '700' }]}
                >
                  {value}
                </Text>
              </View>
              <ProgressBar value={value / 100} tone={barTone(value)} height={6} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default ScoreRing;
