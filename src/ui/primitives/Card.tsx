import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

type Props = {
  children: ReactNode;
  /** `license` draws the card face: laminate sheen, printed border, the larger corner radius. */
  variant?: 'plain' | 'license';
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Card({ children, variant = 'plain', padded = true, style, testID }: Props) {
  const t = useTheme();
  const isLicense = variant === 'license';
  const radius = isLicense ? t.radius.lg : t.radius.md;

  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: t.colors.surface,
          borderRadius: radius,
          borderWidth: isLicense ? 1 : StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          padding: padded ? t.space.lg : 0,
          gap: padded ? t.space.md : 0,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {isLicense ? (
        // The laminate: it leaves the card face as the surface colour and only builds into teal,
        // lilac and pink across the top-right third, so there is no seam to give the overlay away.
        <LinearGradient
          pointerEvents="none"
          colors={[t.colors.surface, t.colors.sheen[0], t.colors.sheen[1], t.colors.sheen[2]]}
          locations={[0, 0.55, 0.8, 1]}
          start={{ x: 0, y: 1 }}
          end={{ x: 1, y: 0 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.18 }]}
        />
      ) : null}
      {children}
    </View>
  );
}
