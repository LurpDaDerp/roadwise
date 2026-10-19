import { useMemo } from 'react';
import { View } from 'react-native';

import { routeLines } from '@/features/analytics/model';
import { loadMaps, regionFor } from '@/features/settings/maps';
import { Text, useTheme, withAlpha } from '@/ui';

import { profileCopy } from './copy';

/**
 * A heat map without a heat layer: every route drawn as a thin, see-through line on a plain map,
 * so roads driven often stack up and glow. One line per privacy run (`routeLines`), never one line
 * across a cut. Hidden from screen readers (it says nothing in words); the caller states what it
 * shows. Used for a friend's shared heat map on their profile.
 */
export function RouteHeatMap({ polylines, height = 360, testID }: { polylines: readonly string[]; height?: number; testID?: string }) {
  const th = useTheme();
  const maps = loadMaps();
  const routes = useMemo(() => routeLines(polylines), [polylines]);
  const region = useMemo(() => {
    const sample: { lat: number; lng: number }[] = [];
    for (const r of routes) for (let i = 0; i < r.length; i += Math.max(1, Math.floor(r.length / 20))) {
      const q = r[i];
      if (q) sample.push({ lat: q.latitude, lng: q.longitude });
    }
    return regionFor(sample);
  }, [routes]);

  if (!maps || !region) {
    return maps ? null : (
      <Text variant="footnote" tone="muted" testID={testID ? `${testID}-nomap` : undefined}>
        {profileCopy.heatmap.noMap}
      </Text>
    );
  }

  // The sky's accent, translucent, so overlapping drives build up into heat.
  const ink = withAlpha(th.colors.accent, th.scheme === 'dark' ? 0.4 : 0.3);
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height, borderRadius: th.radius.card, borderCurve: 'continuous', overflow: 'hidden' }}
    >
      <maps.default
        style={{ flex: 1 }}
        initialRegion={region}
        showsPointsOfInterests={false}
        showsBuildings={false}
        showsTraffic={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        userInterfaceStyle={th.scheme === 'dark' ? 'dark' : 'light'}
      >
        {routes.map((coords, i) => (
          <maps.Polyline key={i} coordinates={coords} strokeColor={ink} strokeWidth={4} lineCap="round" lineJoin="round" />
        ))}
      </maps.default>
    </View>
  );
}
