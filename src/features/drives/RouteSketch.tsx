import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/ui';

import { sketchPaths, type Lead, type Runs } from './route';

/**
 * A static drawing of the route: one SVG path (a subpath per run, so the pen lifts across a
 * privacy cut on a trimmed route), no map tiles, a dot where it starts; with a `lead`-in, a dashed
 * line from where the drive began to the route, and the dot there. Cheap enough for every history
 * row and used again on the share card. Decorative — the row around it says where the drive went.
 */
export function RouteSketch({
  runs,
  lead = null,
  size = 56,
  stroke,
  strokeWidth = 3,
  background,
  testID,
}: {
  runs: Runs;
  /** The dashed lead-in (`leadIn`); none on a history row. */
  lead?: Lead | null;
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  /** Tile background; pass 'transparent' to draw straight on the parent. */
  background?: string;
  testID?: string;
}) {
  const t = useTheme();
  const sketch = useMemo(() => sketchPaths(runs, size, size, strokeWidth + 3, 120, lead), [runs, size, strokeWidth, lead]);
  const ink = stroke ?? t.colors.accent;
  const start = sketch ? (sketch.lead ?? sketch.route).match(/^M([\d.]+) ([\d.]+)/) : null;

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
      {sketch ? (
        <Svg width={size} height={size}>
          {sketch.lead ? (
            <Path d={sketch.lead} stroke={ink} strokeWidth={strokeWidth * 0.6} strokeDasharray={[strokeWidth, strokeWidth * 1.4]} strokeLinecap="round" fill="none" testID="route-sketch-lead" />
          ) : null}
          <Path d={sketch.route} stroke={ink} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
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
