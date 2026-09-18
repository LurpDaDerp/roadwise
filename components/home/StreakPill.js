// StreakPill — flame + streak count; tap explains the rule.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, AutoFitText } from '../../theme';

export function streakColor(streak, t) {
  if (streak <= 0) return t.colors.textSubtle;
  if (streak <= 10) return t.colors.accentMuted;
  if (streak <= 25) return t.colors.accent;
  if (streak <= 50) return t.colors.warning;
  return t.colors.danger;
}

export function StreakPill({ streak = 0, onPress }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Focus streak ${streak}`}
      hitSlop={6}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: t.colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 999,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <MaterialCommunityIcons name="fire" size={24} color={streakColor(streak, t)} />
      <AutoFitText style={[t.typography.numeric, { color: t.colors.text, fontSize: 20, lineHeight: 24, paddingRight: 3 }]}>{String(streak)}</AutoFitText>
    </Pressable>
  );
}

export default StreakPill;
