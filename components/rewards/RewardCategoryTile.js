// RewardCategoryTile — a reward-catalog category as an image tile.
// The catalog has no partners yet, so the tile never navigates: it reports
// "coming soon" through the screen-level snackbar.
import React from 'react';
import { View, Text, Pressable, ImageBackground, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pill, useTheme } from '../../theme';

export default function RewardCategoryTile({ label, icon, image, onPress }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, coming soon`}
      android_ripple={{ color: 'rgba(255,255,255,0.12)' }}
      style={({ pressed }) => [
        {
          borderRadius: t.radius.lg,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          ...t.elevation.card,
        },
        pressed && { transform: [{ scale: 0.99 }], opacity: 0.92 },
      ]}
    >
      <ImageBackground
        source={image}
        style={{ height: 72, justifyContent: 'center' }}
        imageStyle={{ borderRadius: t.radius.lg }}
      >
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: t.isDark ? 'rgba(6,10,12,0.58)' : 'rgba(0,0,0,0.42)',
          }}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: 'rgba(255,255,255,0.16)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name={icon} size={17} color="#fff" />
            </View>
            <Text
              style={{
                color: '#fff',
                fontSize: 16,
                fontWeight: '700',
                letterSpacing: -0.2,
                textShadowColor: 'rgba(0,0,0,0.6)',
                textShadowRadius: 4,
                flex: 1,
                paddingRight: 8,
              }}
              numberOfLines={1}
            >
              {label}
            </Text>
          </View>
          <Pill
            label="Soon"
            style={{
              backgroundColor: t.isDark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.92)',
            }}
          />
        </View>
      </ImageBackground>
    </Pressable>
  );
}
