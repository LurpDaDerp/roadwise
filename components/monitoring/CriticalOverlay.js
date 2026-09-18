// CriticalOverlay — [MP-3] full-screen overlay for CRITICAL alerts (eyes
// closed, microsleep, prolonged stare…). Pulsing red, one huge phrase, no
// buttons: it disappears on its own when the alert clears. Touch passes through
// to nothing — the driver should not be interacting with the phone.
import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, StyleSheet, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';
import { ALERT_SEVERITY } from '../../monitoring/types';

export function CriticalOverlay({ alert }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;
  const visible = !!alert && alert.severity === ALERT_SEVERITY.CRITICAL;

  useEffect(() => {
    if (!visible) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);

  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="assertive"
      style={[StyleSheet.absoluteFillObject, { zIndex: 5000, elevation: 50, justifyContent: 'center', alignItems: 'center' }]}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          {
            backgroundColor: t.colors.danger,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.72, 0.94] }),
          },
        ]}
      />
      <Ionicons name={alert.icon || 'alert-circle'} size={96} color="#fff" style={{ marginBottom: 16 }} />
      <Text
        style={{
          color: '#fff',
          fontSize: 48,
          fontWeight: '900',
          letterSpacing: -1,
          textAlign: 'center',
          paddingHorizontal: 24,
          lineHeight: 54,
        }}
        adjustsFontSizeToFit
        numberOfLines={2}
      >
        {(alert.title || 'Attention').toUpperCase()}
      </Text>
      {!!alert.message && (
        <Text
          style={{ color: 'rgba(255,255,255,0.9)', fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 12, paddingHorizontal: 32 }}
          numberOfLines={2}
        >
          {alert.message}
        </Text>
      )}
    </View>
  );
}

export default CriticalOverlay;
