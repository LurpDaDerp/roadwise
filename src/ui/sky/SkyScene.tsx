import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../theme';
import { mix, withAlpha } from './color';
import { SkyFade } from './SkyFade';

/**
 * The scene card's picture: the sky's deep gradient for this hour and weather, with a road over
 * low hills along the bottom. Every layer only darkens the gradient, so the white text a scene card
 * carries keeps the contrast its stops were repaired for. A change of sky fades it on the UI thread
 * (`SkyFade`). Decorative: hidden from screen readers.
 */
export function SkyScene({ road = true }: { road?: boolean }) {
  const t = useTheme();
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <SkyFade look={t.sky.scene} paint={(scene) => <Scene scene={scene} road={road} />} />
    </View>
  );
}

function Scene({ scene, road }: { scene: readonly [string, string, string]; road: boolean }) {
  const [a, b, c] = scene;
  const far = withAlpha(mix(c, '#000000', 0.25), 0.55);
  const near = withAlpha(mix(c, '#000000', 0.45), 0.75);
  const lane = withAlpha('#000000', 0.18);
  return (
    <>
      <LinearGradient colors={[a, b, c]} locations={[0, 0.55, 1]} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
      {road ? (
        <Svg width="100%" height="46%" viewBox="0 0 400 140" preserveAspectRatio="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <Path d="M0 70 C 70 42, 120 60, 180 48 C 250 34, 320 58, 400 40 L 400 140 L 0 140 Z" fill={far} />
          <Path d="M0 104 C 90 82, 170 98, 250 86 C 320 76, 360 90, 400 82 L 400 140 L 0 140 Z" fill={near} />
          <Path d="M214 140 L 236 92 L 246 92 L 300 140 Z" fill={lane} />
        </Svg>
      ) : null}
    </>
  );
}
