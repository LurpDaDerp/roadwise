import React, { useEffect, useState } from 'react';
import { Text, StyleSheet } from 'react-native';

// AutoFitText — wraps Text so long numbers/text shrink to fit their container.
// Two defensive measures (added to stop a native "forEach of null" crash that
// fired during stack transitions on screens using large tabular-nums Text):
//   1. Strips `fontVariant` from incoming styles. iOS has a layout bug where
//      tabular-nums combined with adjustsFontSizeToFit can throw inside the
//      native text-measurement path while a screen is still transitioning in.
//   2. Defers enabling `adjustsFontSizeToFit` until after the first paint, so
//      native auto-sizing never runs mid-transition.
export function AutoFitText({
  children,
  style,
  numberOfLines = 1,
  minimumFontScale = 0.5,
  adjustsFontSizeToFit = true,
  ...rest
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const flat = StyleSheet.flatten(style) || {};
  // Remove fontVariant — known to interact badly with adjustsFontSizeToFit on iOS.
  const { fontVariant, ...safeStyle } = flat;

  return (
    <Text
      {...rest}
      style={safeStyle}
      numberOfLines={numberOfLines}
      adjustsFontSizeToFit={ready && adjustsFontSizeToFit}
      minimumFontScale={minimumFontScale}
    >
      {children}
    </Text>
  );
}

export default AutoFitText;
