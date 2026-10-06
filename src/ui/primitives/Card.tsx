import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemeProvider, useTheme } from '../theme';

export type CardVariant = 'plain' | 'raised' | 'hero' | 'outline' | 'license';

export type CardProps = {
  children: ReactNode;
  /**
   * - `plain` (default): the surface card. Light: white with a soft navy shadow. Dark: prussian with a hairline.
   * - `raised`: one step up (surfaceRaised) — a card inside a sheet, a selected tile.
   * - `hero`: the navy brand card for the one headline block on a screen (Home header, summary
   *   points). A regal-to-prussian navy gradient in both schemes; its children render under the
   *   dark palette automatically, so any primitive inside reads correctly.
   * - `outline`: no fill, a strong rule. Placeholders, "add" slots.
   * - `license`: @deprecated alias of `hero`, kept so v2 screens compile.
   */
  variant?: CardVariant;
  /** Default true: 16 pt padding and 12 pt gap between children. */
  padded?: boolean;
  /** Makes the whole card one button. Give it an `accessibilityLabel` that says what it opens. */
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Layout only. Merged last. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** The hero card's fixed navy gradient, independent of scheme. */
export const HERO_CARD_GRADIENT = ['#003566', '#001D3D'] as const;

/** A chunky rounded card. Never nest one card inside another; group with `Divider` or `ListRow`. */
export function Card({
  children,
  variant = 'plain',
  padded = true,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: CardProps) {
  const t = useTheme();
  const v = variant === 'license' ? 'hero' : variant;
  const dark = t.scheme === 'dark';

  const face: ViewStyle = {
    borderRadius: t.radius.card,
    borderCurve: 'continuous',
    padding: padded ? t.space.lg : 0,
    gap: padded ? t.space.md : 0,
    overflow: 'hidden',
    ...{
      plain: {
        backgroundColor: t.colors.surface,
        borderWidth: dark ? 1 : 0,
        borderColor: t.colors.divider,
        boxShadow: t.elevation.card,
      },
      raised: {
        backgroundColor: t.colors.surfaceRaised,
        borderWidth: 0,
        boxShadow: t.elevation.raised,
      },
      hero: {
        backgroundColor: HERO_CARD_GRADIENT[1],
        borderWidth: dark ? 1 : 0,
        borderColor: t.colors.border,
        boxShadow: t.elevation.raised,
      },
      outline: {
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderColor: t.colors.borderStrong,
        borderStyle: 'dashed' as const,
      },
    }[v],
  };

  const body =
    v === 'hero' ? (
      <>
        <LinearGradient
          pointerEvents="none"
          colors={HERO_CARD_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <ThemeProvider scheme="dark" reduceMotion={t.reduceMotion}>
          {children}
        </ThemeProvider>
      </>
    ) : (
      children
    );

  if (!onPress) {
    return (
      <View testID={testID} style={[face, style]}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        face,
        { transform: [{ scale: pressed ? 0.98 : 1 }], opacity: pressed ? 0.92 : 1 },
        style,
      ]}
    >
      {body}
    </Pressable>
  );
}
