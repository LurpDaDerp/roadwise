import { View } from 'react-native';

import { loadMaps, type Region } from '@/features/settings/maps';
import { Card, Text, useTheme, withAlpha } from '@/ui';

import { analyticsCopy } from './copy';
import type { MapPoint } from './model';

/** The map's height in the card. */
export const TRIPS_MAP_HEIGHT = 320;

/**
 * Every trip ever, drawn as thin see-through lines so roads driven often build up. It opens on
 * `fitRegion` (the most-driven roads in the middle) and pans and zooms freely. The map itself is
 * hidden from screen readers; the card's title says what it is. Without the maps module it says
 * so in a line instead.
 */
export function TripsMapCard({ routes, region }: { routes: readonly MapPoint[][]; region: Region | null }) {
  const t = useTheme();
  const maps = loadMaps();
  const ink = withAlpha(t.colors.accent, t.scheme === 'dark' ? 0.45 : 0.35);

  let body;
  if (!region || routes.length === 0) {
    body = (
      <Text variant="subhead" tone="muted" testID="trips-map-empty">
        {analyticsCopy.map.empty}
      </Text>
    );
  } else if (!maps) {
    body = (
      <Text variant="subhead" tone="muted" testID="trips-map-nomap">
        {analyticsCopy.map.noMap}
      </Text>
    );
  } else {
    body = null;
  }

  return (
    <Card padded={false} testID="analytics-map">
      <View style={{ padding: t.space.lg, gap: t.space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: t.space.md }}>
          <Text variant="title3" accessibilityRole="header">
            {analyticsCopy.map.title}
          </Text>
          <Text variant="footnote" tone="subtle">
            {analyticsCopy.map.caption}
          </Text>
        </View>
        {body}
      </View>
      {maps && region && routes.length > 0 ? (
        <View
          testID="trips-map"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ height: TRIPS_MAP_HEIGHT }}
        >
          <maps.default
            style={{ flex: 1 }}
            initialRegion={region}
            scrollEnabled
            zoomEnabled
            pitchEnabled={false}
            rotateEnabled={false}
            showsPointsOfInterests={false}
            showsBuildings={false}
            showsTraffic={false}
            toolbarEnabled={false}
            userInterfaceStyle={t.scheme === 'dark' ? 'dark' : 'light'}
          >
            {routes.map((coords, i) => (
              <maps.Polyline key={i} coordinates={coords} strokeColor={ink} strokeWidth={4} lineCap="round" lineJoin="round" />
            ))}
          </maps.default>
        </View>
      ) : null}
    </Card>
  );
}
