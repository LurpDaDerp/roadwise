import type { TextStyle } from 'react-native';

import { tokens, type TypeVariant } from '@/ui';
import { MAX_FONT_SCALE } from '@/ui/primitives/Text';

/**
 * A type style's size at a Dynamic Type multiple, capped the way `Text` caps it (the style's own
 * `maxScale`, else 2×). Pass it as a `Text` style to draw at a scale other than the system's, or
 * `base` to scale a different size in the same way.
 */
export function sizeAt(variant: TypeVariant, scale: number, base?: { fontSize: number; lineHeight: number }): { fontSize: number; lineHeight: number } & TextStyle {
  const s = tokens.type[variant];
  const k = Math.min(scale, s.maxScale ?? MAX_FONT_SCALE);
  const b = base ?? s;
  return { fontSize: b.fontSize * k, lineHeight: b.lineHeight * k };
}
