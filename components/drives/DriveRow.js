// DriveRow — one drive in the history list: verdict icon, when it happened,
// duration / distance / points, and the drive score as a chip.
import React, { useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Chip, scoreColor, useTheme } from '../../theme';
import { scoreDrive } from '../../utils/driveScore';
import { formatDateTime, formatDuration, formatDistance } from '../../utils/format';

// 'rgb(r,g,b)' → 'rgba(r,g,b,a)' so a chip can carry the score-gradient colour.
export function scoreTint(rgb, alpha = 0.16) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(String(rgb));
  if (!m) return 'transparent';
  return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
}

export function scoreTone(score) {
  const s = Number(score) || 0;
  if (s >= 75) return 'success';
  if (s >= 50) return 'warning';
  return 'danger';
}

// A drive is distracted when the new flag says so, else when phone pickups > 0.
export function isDistractedDrive(drive) {
  if (!drive) return false;
  return drive.wasDistracted ?? (Number(drive.distracted) || 0) > 0;
}

export function driveScoreValue(drive) {
  if (!drive) return 0;
  return typeof drive.score === 'number' ? drive.score : scoreDrive(drive).score;
}

// Memoised: the history list mounts every row it has ever loaded (20 more per "Load more"),
// and each row runs a drive score, a colour mix, a regex and two locale date formatters. With
// the parent re-rendering, all of that ran again for every row.
export const DriveRow = React.memo(function DriveRow({ drive, onPress, first = false, unit = 'mph' }) {
  const t = useTheme();
  const row = useMemo(() => {
    if (!drive) return null;
    const score = driveScoreValue(drive);
    const points = Number(drive.points) || 0;
    return {
      distracted: isDistractedDrive(drive),
      score,
      color: scoreColor(score, t),
      caption: [
        formatDuration(drive.duration),
        formatDistance(drive.totalDistance, unit),
        `+${points} pts`,
      ].join(' · '),
      when: formatDateTime(drive.timestamp),
    };
  }, [drive, unit, t]);
  // A stable handler: the parent passes the drive, not a fresh arrow per row per render.
  const press = useCallback(() => onPress && onPress(drive), [onPress, drive]);
  if (!drive || !row) return null;
  const { distracted, score, color, caption, when } = row;

  return (
    <Pressable
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={`${distracted ? 'Distracted' : 'Focused'} drive, ${when}, score ${score}`}
      android_ripple={{ color: t.colors.accentFaint }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 14,
          paddingHorizontal: 18,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: t.colors.divider,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          backgroundColor: distracted ? t.colors.dangerFaint : t.colors.accentFaint,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <Ionicons
          name={distracted ? 'alert-circle' : 'checkmark-circle'}
          size={20}
          color={distracted ? t.colors.danger : t.colors.accent}
        />
      </View>

      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={[t.typography.bodyStrong, { color: t.colors.text }]} numberOfLines={1}>
          {when}
        </Text>
        <Text
          style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}
          numberOfLines={1}
        >
          {caption}
        </Text>
      </View>

      <Chip
        label={String(score)}
        tone={scoreTone(score)}
        style={{ backgroundColor: scoreTint(color) }}
      />
      <Ionicons
        name="chevron-forward"
        size={18}
        color={t.colors.textSubtle}
        style={{ marginLeft: 8 }}
      />
    </Pressable>
  );
});

export default DriveRow;
