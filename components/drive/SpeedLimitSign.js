// SpeedLimitSign — road-sign styled limit badge. "EST." marks the 25 mph
// default used when no limit is known for the road; pulses red while speeding.
import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, Easing } from 'react-native';
import { useTheme, AutoFitText } from '../../theme';

export function SpeedLimitSign({ limit, unit, isDefault, speeding, size = 92 }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!speeding) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 500, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 500, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [speeding, pulse]);

  const borderColor = pulse.interpolate({ inputRange: [0, 1], outputRange: ['#111111', t.colors.danger] });
  const isKph = unit === 'kph';
  return (
    <Animated.View
      accessibilityLabel={`Speed limit ${Math.round(limit)} ${isKph ? 'kilometres per hour' : 'miles per hour'}${isDefault ? ', estimated' : ''}`}
      style={{
        width: size,
        height: size * 1.18,
        borderRadius: isKph ? size / 2 : 12,
        backgroundColor: '#ffffff',
        borderWidth: isKph ? 6 : 3,
        borderColor: isKph ? (speeding ? t.colors.danger : '#e02e24') : borderColor,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: isKph ? 0 : 6,
        opacity: isDefault ? 0.82 : 1,
      }}
    >
      {!isKph && (
        <Text style={{ color: '#111', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 }}>SPEED</Text>
      )}
      {!isKph && (
        <Text style={{ color: '#111', fontSize: 10, fontWeight: '800', letterSpacing: 1.2, marginBottom: 2 }}>LIMIT</Text>
      )}
      <AutoFitText style={{ color: '#111', fontSize: size * 0.46, fontWeight: '900', letterSpacing: -1, lineHeight: size * 0.5 }}>
        {Math.round(limit)}
      </AutoFitText>
      {isDefault && (
        <View style={{ position: 'absolute', bottom: 4, backgroundColor: '#111', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6 }}>
          <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 }}>EST.</Text>
        </View>
      )}
    </Animated.View>
  );
}

export default SpeedLimitSign;
