import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { SkyScene } from '../sky/SkyScene';
import { SceneScope, useTheme } from '../theme';

export type CardVariant = 'plain' | 'raised' | 'hero' | 'outline' | 'license';

export type CardProps = {
  children: ReactNode;
  /**
   * - `plain` (default): the surface card. Light: paper white with a soft shadow. Dark: a
   *   charcoal face with a hairline.
   * - `raised`: one step up (surfaceRaised) — a card inside a sheet, a selected tile.
   * - `hero`: the scene card for the one headline block on a screen (Home's drive card, the
   *   summary points, a league or profile header): the sky's deep gradient for this hour and
   *   weather, with a road over low hills. Its children render under the scene palette
   *   automatically (white ink, repaired to AA on every stop), so any primitive inside reads.
   * - `outline`: no fill, a strong rule. Placeholders, "add" slots.
   * - `license`: @deprecated alias of `hero`, kept so v2 screens compile.
   */
  variant?: CardVariant;
  /** Default true: 16 pt padding (20 on a hero) and 12 pt gap between children. */
  padded?: boolean;
  /** Draw the hero's road silhouette (default true). Off for a short hero where it would crowd the text. */
  road?: boolean;
  /** Makes the whole card one button. Give it an `accessibilityLabel` that says what it opens. */
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Layout only. Merged last. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** A big rounded card. Never nest one card inside another; group with `Divider` or `ListRow`. */
export function Card({
  children,
  variant = 'plain',
  padded = true,
  road = true,
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
    padding: padded ? (v === 'hero' ? t.space.lg + t.space.xs : t.space.lg) : 0,
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
        backgroundColor: t.sky.scene[2],
        borderWidth: 0,
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
        <SkyScene road={road} />
        <SceneScope>{children}</SceneScope>
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
