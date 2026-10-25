// DEMO ONLY (temporary): the name of the theme on show, top right, in white bold with a black shadow.
import { StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDemo, useDemoTheme } from './demoStore';

export function DemoThemeLabel() {
  const theme = useDemoTheme();
  const { weatherWarning } = useDemo();
  const insets = useSafeAreaInsets();
  // The weather warning has its own scene and no label.
  if (theme === null || weatherWarning) return null;
  return (
    <Text
      testID="demo-theme-label"
      pointerEvents="none"
      allowFontScaling={false}
      numberOfLines={1}
      style={[styles.label, { top: Math.max(insets.top - 6, 4), right: Math.max(insets.right, 16) }]}
    >
      {theme.label}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    position: 'absolute',
    zIndex: 1000,
    elevation: 1000,
    color: '#FFFFFF',
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '800',
    textShadowColor: '#000000',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
});
