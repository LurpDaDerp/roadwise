import React from 'react';
import { View, Text, StyleSheet, ImageBackground } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, Eyebrow } from '../theme';

export default function ComingSoon({ category, icon }) {
  const t = useTheme();
  return (
    <ImageBackground
      source={require('../assets/comingsoon.jpg')}
      style={{ flex: 1 }}
      resizeMode="cover"
    >
      <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
      <View
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: 'rgba(6,10,12,0.65)' },
        ]}
      />
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 32,
        }}
      >
        {!!category && (
          <Eyebrow style={{ color: t.colors.accent, marginBottom: 16 }}>
            {category}
          </Eyebrow>
        )}
        <View
          style={{
            width: 88,
            height: 88,
            borderRadius: 44,
            backgroundColor: 'rgba(0,179,134,0.18)',
            borderWidth: 1,
            borderColor: t.colors.accent,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 28,
          }}
        >
          <Ionicons name={icon || 'sparkles-outline'} size={40} color={t.colors.accent} />
        </View>
        <Text
          style={{
            color: '#fff',
            fontSize: 36,
            fontWeight: '800',
            letterSpacing: -0.8,
            textAlign: 'center',
          }}
        >
          Coming soon
        </Text>
        <Text
          style={{
            color: 'rgba(255,255,255,0.75)',
            fontSize: 15,
            lineHeight: 22,
            textAlign: 'center',
            marginTop: 12,
            maxWidth: 320,
          }}
        >
          We're partnering with brands to bring you redeemable rewards here. Keep earning points in the meantime.
        </Text>
      </View>
    </ImageBackground>
  );
}
