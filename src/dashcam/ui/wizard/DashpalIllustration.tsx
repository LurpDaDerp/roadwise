import { View } from 'react-native';
import Svg, { Circle, Rect } from 'react-native-svg';

import { useTheme } from '@/ui';

/**
 * The DashPal as a picture: a rounded body on its mount, the lens ring and the status light. Drawn
 * with the theme's colours only, so a restyle recolours it. `glyph` is the 48-pt card variant.
 */
export function DashpalIllustration({ size = 160, glyph = false, testID }: { size?: number; glyph?: boolean; testID?: string }) {
  const th = useTheme();
  const c = th.colors;
  const w = glyph ? 48 : size;
  const h = Math.round(w * (100 / 120));
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: w, height: h }} testID={testID}>
      <Svg width={w} height={h} viewBox="0 0 120 100">
        <Rect x={46} y={4} width={28} height={16} rx={5} fill={c.borderStrong} />
        <Rect x={10} y={16} width={100} height={74} rx={20} fill={c.surfaceRaised} stroke={c.borderStrong} strokeWidth={glyph ? 6 : 3} />
        <Circle cx={60} cy={54} r={25} fill={c.text} />
        <Circle cx={60} cy={54} r={15} fill={c.accentFaint} stroke={c.textMuted} strokeWidth={2} />
        <Circle cx={60} cy={54} r={7} fill={c.text} />
        {glyph ? null : <Circle cx={54} cy={48} r={3} fill={c.surface} opacity={0.8} />}
        <Circle cx={94} cy={31} r={glyph ? 6 : 4.5} fill={c.accent} />
      </Svg>
    </View>
  );
}
