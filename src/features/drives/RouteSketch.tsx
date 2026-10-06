import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import type { LatLng } from '@/lib/geo';
import { useTheme } from '@/ui';

import { sketchPath } from './route';

/**
 * A static drawing of the route: one SVG path, no map tiles. Cheap enough for every history row
 * and used again on the share card. Decorative — the row around it says where the drive went.
 */
export function RouteSketch({
  points,
  size = 56,
  stroke,
  strokeWidth = 3,
  background,
  testID,
}: {
  points: readonly LatLng[];
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  /** Tile background; pass 'transparent' to draw straight on the parent. */
  background?: string;
  testID?: string;
}) {
  const t = useTheme();
  const d = useMemo(() => sketchPath(points, size, size, strokeWidth + 3), [points, size, strokeWidth]);
  const ink = stroke ?? t.colors.accent;
  const start = d ? d.match(/^M([\d.]+) ([\d.]+)/) : null;

  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: t.radius.md,
        borderCurve: 'continuous',
        backgroundColor: background ?? t.colors.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {d ? (
        <Svg width={size} height={size}>
          <Path d={d} stroke={ink} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {start ? <Circle cx={Number(start[1])} cy={Number(start[2])} r={strokeWidth} fill={ink} /> : null}
        </Svg>
      ) : (
        <Svg width={size / 2} height={size / 2} viewBox="0 0 24 24">
          {/* No route saved (a very short drive, or all inside a privacy zone): a quiet dot. */}
          <Circle cx={12} cy={12} r={4} fill={t.colors.textSubtle} />
        </Svg>
      )}
    </View>
  );
}
