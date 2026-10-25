// DEMO ONLY (temporary): the name of the theme on show, top right, in white bold with a black shadow.
import { StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDemoTheme } from './demoStore';

export function DemoThemeLabel() {
  const theme = useDemoTheme();
  const insets = useSafeAreaInsets();
  if (theme === null) return null;
  return (
    <Text
      testID="demo-theme-label"
      pointerEvents="none"
      allowFontScaling={false}
      numberOfLines={1}
      style={[styles.label, { top: Math.max(insets.top - 4, 4), right: Math.max(insets.right, 16) }]}
    >
      {theme.label}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    position: 'absolute',
    zIndex: 100,
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    textShadowColor: '#000000',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
});
