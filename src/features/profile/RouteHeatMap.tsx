import { useMemo } from 'react';
import { View } from 'react-native';

import { loadMaps, regionFor } from '@/features/settings/maps';
import { decodeRuns } from '@/lib/polyline';
import { Text, useTheme } from '@/ui';

import { profileCopy } from './copy';

/**
 * Decoded routes, one line per visible run: a route stored as several runs (privacy cuts) becomes
 * several lines, never one line across the gap. Any run that doesn't decode to a line is skipped.
 */
export function decodeRoutes(polylines: readonly string[]): { latitude: number; longitude: number }[][] {
  const out: { latitude: number; longitude: number }[][] = [];
  for (const p of polylines) {
    try {
      for (const pts of decodeRuns(p)) {
        if (pts.length >= 2) out.push(pts.map((q) => ({ latitude: q.lat, longitude: q.lng })));
      }
    } catch {
      // A malformed route draws nothing.
    }
  }
  return out;
}

/**
 * A heat map without a heat layer: every route drawn as a thin, see-through line on a plain map,
 * so roads driven often stack up and glow. Hidden from screen readers (it says nothing in words);
 * the caller states what it shows.
 */
export function RouteHeatMap({ polylines, height = 360, testID }: { polylines: readonly string[]; height?: number; testID?: string }) {
  const th = useTheme();
  const maps = loadMaps();
  const routes = useMemo(() => decodeRoutes(polylines), [polylines]);
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

  const ink = th.scheme === 'dark' ? 'rgba(255, 195, 0, 0.35)' : 'rgba(0, 53, 102, 0.28)';
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
