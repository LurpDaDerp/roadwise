// RecentDriveRow — compact drive row for the Home screen.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme, Chip, scoreColor } from '../../theme';
import { formatDateTime, formatDuration, formatDistance } from '../../utils/format';
import { scoreDrive } from '../../utils/driveScore';

export function RecentDriveRow({ drive, unit, onPress, first }) {
  const t = useTheme();
  const distracted = drive.wasDistracted ?? (Number(drive.distracted) || 0) > 0;
  const score = typeof drive.score === 'number' ? drive.score : scoreDrive(drive).score;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: t.colors.divider, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: distracted ? t.colors.dangerFaint : t.colors.accentFaint, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
        <Ionicons name={distracted ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={18} color={distracted ? t.colors.danger : t.colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[t.typography.bodyStrong, { color: t.colors.text }]} numberOfLines={1}>{formatDateTime(drive.timestamp)}</Text>
        <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]} numberOfLines={1}>
          {formatDuration(drive.duration)} · {formatDistance(drive.totalDistance, unit)} · +{drive.points ?? 0} pts
        </Text>
      </View>
      <Chip label={String(score)} tone="neutral" style={{ backgroundColor: 'transparent', borderWidth: 1.5, borderColor: scoreColor(score, t), marginRight: 6 }} />
      <Ionicons name="chevron-forward" size={16} color={t.colors.textSubtle} />
    </Pressable>
  );
}

export default RecentDriveRow;
