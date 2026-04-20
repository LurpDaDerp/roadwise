import React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// Wrapper around expo-linear-gradient that defends against a known bug where
// the `colors` prop can momentarily be null during native-stack transitions,
// causing ExpoLinearGradient to throw "Cannot read property 'forEach' of null".
// If colors is invalid, fall back to a plain View with the first usable color.
export function SafeGradient({ colors, style, children, ...rest }) {
  const safe =
    Array.isArray(colors)
      ? colors.filter((c) => typeof c === 'string' && c.length > 0)
      : [];

  if (safe.length < 2) {
    const bg = safe[0] || 'transparent';
    return (
      <View style={[{ backgroundColor: bg }, style]}>
        {children}
      </View>
    );
  }

  return (
    <LinearGradient colors={safe} style={style} {...rest}>
      {children}
    </LinearGradient>
  );
}

export default SafeGradient;
