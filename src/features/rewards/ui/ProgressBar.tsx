import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui';

/**
 * A printed progress rule: a hairline track with an ID-blue fill. Always drawn beside text that
 * says the same thing, so it is hidden from screen readers and never the only carrier of the value.
 */
export function ProgressBar({ fraction, testID }: { fraction: number; testID?: string }) {
  const t = useTheme();
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 8,
        borderRadius: t.radius.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.borderStrong,
        backgroundColor: t.colors.surfaceRaised,
        overflow: 'hidden',
      }}
    >
      <View
        testID={testID ? `${testID}-fill` : undefined}
        style={{ width: `${Math.round(f * 1000) / 10}%`, height: '100%', backgroundColor: t.colors.accent }}
      />
    </View>
  );
}
