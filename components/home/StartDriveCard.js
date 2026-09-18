// StartDriveCard — the Home hero. One tap → DrivePrep.
import React from 'react';
import { View, Text, Pressable, ImageBackground, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';

export function StartDriveCard({ onPress, subtitle, eyebrow = 'Ready when you are' }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Start drive"
      style={({ pressed }) => ({ borderRadius: t.radius.lg, overflow: 'hidden', height: 150, opacity: pressed ? 0.92 : 1, ...t.elevation.card })}
    >
      <ImageBackground source={require('../../assets/drivebutton.jpeg')} style={{ flex: 1, justifyContent: 'flex-end' }} imageStyle={{ borderRadius: t.radius.lg }} resizeMode="cover">
        <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(4,8,10,0.58)' }} />
        <View style={{ padding: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: '700', letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 4 }}>{eyebrow}</Text>
            <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>Start drive</Text>
            {!!subtitle && <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600', marginTop: 4 }} numberOfLines={1}>{subtitle}</Text>}
          </View>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="play" size={26} color={t.colors.accentText} style={{ marginLeft: 3 }} />
          </View>
        </View>
      </ImageBackground>
    </Pressable>
  );
}

export default StartDriveCard;
