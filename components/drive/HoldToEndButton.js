// HoldToEndButton — press and hold to end the drive; a fill animates across
// the button so an accidental tap never ends a drive.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View, Easing } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../theme';

const HOLD_MS = 1200;

export const HoldToEndButton = React.memo(function HoldToEndButton({
  onComplete, label = 'Hold to end drive', disabled,
}) {
  const t = useTheme();
  const fill = useRef(new Animated.Value(0)).current;
  const timer = useRef(null);
  const [holding, setHolding] = useState(false);
  const [width, setWidth] = useState(0);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = () => {
    if (disabled) return;
    setHolding(true);
    fill.setValue(0);
    Animated.timing(fill, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: false }).start();
    timer.current = setTimeout(() => {
      setHolding(false);
      onComplete?.();
    }, HOLD_MS);
  };
  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setHolding(false);
    Animated.timing(fill, { toValue: 0, duration: 180, useNativeDriver: false }).start();
  };

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Press and hold for one second"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        height: 64,
        borderRadius: t.radius.lg,
        backgroundColor: t.colors.surfaceRaised,
        borderWidth: 1.5,
        borderColor: holding ? t.colors.accent : t.colors.borderStrong,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: fill.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(width, 1)] }),
          backgroundColor: t.colors.accent,
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Ionicons name="stop-circle-outline" size={24} color={holding ? t.colors.accentText : t.colors.text} />
        <Text style={{ color: holding ? t.colors.accentText : t.colors.text, fontSize: 18, fontWeight: '800', letterSpacing: 0.2 }}>
          {holding ? 'Keep holding…' : label}
        </Text>
      </View>
    </Pressable>
  );
});

export default HoldToEndButton;
