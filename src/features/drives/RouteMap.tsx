import { Ionicons } from '@expo/vector-icons';
import type { Tier } from '@scoring';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { LatLng } from '@/lib/geo';
import { Text, ThemeProvider, tokens, useTheme } from '@/ui';

import { EVENT_ICON, eventName, formatClock, TIER_SIGNAL } from './format';
import type { LocalDriveEvent } from './model';
import { regionFor, routeDots, routeRuns } from './route';
import { RouteSketch } from './RouteSketch';

export type MapsModule = typeof import('react-native-maps');

let cached: MapsModule | null | undefined;

/**
 * The native maps module, or null when this build has none (Expo Go, Jest, an old dev build).
 * Required at render time, not imported, because the package reaches for its native module the
 * moment it is evaluated. The failure is cached too, so a build without it pays for one throw.
 */
export function loadMaps(): MapsModule | null {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('react-native-maps') as MapsModule;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Test seam: forget what `loadMaps` cached. */
export function resetMapsCache(): void {
  cached = undefined;
}

const MAP_HEIGHT = 240;
/**
 * Map tiles follow the system appearance, not the app's scheme, so the route inks are pinned to
 * the light palette's signal fills: strong enough on both light and dark tiles. The legend uses
 * the same values, and every colour also has a word there.
 */
const INK = tokens.color.light.signal;
const inkFor = (tier: Tier | null) => (tier === null ? INK.clean.fill : INK[TIER_SIGNAL[tier]].fill);
const RING = tokens.color.light.accent;

const LEGEND: { tier: Tier | null; label: string }[] = [
  { tier: null, label: 'Clean' },
  { tier: 'minor', label: 'Minor' },
  { tier: 'moderate', label: 'Moderate' },
  { tier: 'severe', label: 'Severe' },
];

function Legend() {
  const t = tokens.color.light;
  return (
    <ThemeProvider scheme="light">
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 8,
          top: 8,
          paddingHorizontal: 8,
          paddingVertical: 6,
          gap: 2,
          borderRadius: 10,
          backgroundColor: t.surface,
          opacity: 0.94,
        }}
      >
        {LEGEND.map((l) => (
          <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: inkFor(l.tier) }} />
            <Text variant="caption" tone="muted">
              {l.label}
            </Text>
          </View>
        ))}
      </View>
    </ThemeProvider>
  );
}

/** The words under the map for the event tapped in the breakdown. */
export function highlightCaption(e: LocalDriveEvent): string {
  const what = `${eventName(e.type, e.tier)} at ${formatClock(e.startedAt)}`;
  return e.lat === null || e.lng === null
    ? `${what} happened in a privacy zone or the trimmed ends, so it isn't on the map.`
    : `Circled on the map: ${what}`;
}

/**
 * The route map on the summary: a plain base map, the route coloured by the worst event along
 * each stretch (green clean, then yellow, orange, red), instant events as yellow or red dots, a
 * small legend in the corner, and a ring around the event tapped in the breakdown. Static: it
 * never steals the page scroll. Hidden from screen readers — the breakdown lists every event in
 * words, and the caption below says what is circled.
 */
export function RouteMap({
  points,
  events,
  highlighted,
  testID = 'route-map',
}: {
  points: readonly LatLng[];
  events: readonly LocalDriveEvent[];
  highlighted: LocalDriveEvent | null;
  testID?: string;
}) {
  const t = useTheme();
  const runs = useMemo(() => routeRuns(points, events), [points, events]);
  const dots = useMemo(() => routeDots(events), [events]);
  const region = useMemo(() => regionFor(points), [points]);
  const maps = loadMaps();
  const ring = highlighted && highlighted.lat !== null && highlighted.lng !== null ? { lat: highlighted.lat, lng: highlighted.lng } : null;

  const frame = {
    height: MAP_HEIGHT,
    borderRadius: t.radius.card,
    borderCurve: 'continuous' as const,
    overflow: 'hidden' as const,
    backgroundColor: t.colors.surfaceRaised,
  };

  let body: React.ReactNode;
  if (points.length < 2) {
    body = (
      <View style={[frame, { height: 120, alignItems: 'center', justifyContent: 'center', padding: t.space.lg, gap: t.space.xs }]} testID="no-route">
        <Ionicons name="map-outline" size={t.size.iconLg} color={t.colors.textSubtle} />
        <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }}>
          No route to show. Very short drives and privacy zones are left off the map.
        </Text>
      </View>
    );
  } else if (maps === null || region === null) {
    body = (
      <View style={[frame, { alignItems: 'center', justifyContent: 'center' }]} testID="map-unavailable" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <RouteSketch points={points} size={MAP_HEIGHT - 32} strokeWidth={4} background="transparent" />
      </View>
    );
  } else {
    const MapView = maps.default;
    const { Marker, Polyline } = maps;
    const coords = (ps: readonly LatLng[]) => ps.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    body = (
      <View style={frame} testID="map-canvas" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <MapView
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          scrollEnabled={false}
          zoomEnabled={false}
          rotateEnabled={false}
          pitchEnabled={false}
          toolbarEnabled={false}
          showsUserLocation={false}
          showsPointsOfInterests={false}
          liteMode
        >
          {runs.map((run, i) => (
            <Polyline key={i} coordinates={coords(run.points)} strokeWidth={5} strokeColor={inkFor(run.tier)} lineCap="round" lineJoin="round" />
          ))}
          {dots.map((dot) => (
            <Marker key={dot.id} coordinate={{ latitude: dot.at.lat, longitude: dot.at.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} testID={`dot-${dot.id}`}>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: inkFor(dot.tier),
                  borderWidth: 2,
                  borderColor: tokens.color.light.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name={EVENT_ICON[dot.type]} size={12} color={INK[TIER_SIGNAL[dot.tier]].onFill} />
              </View>
            </Marker>
          ))}
          {ring ? (
            <Marker key={`ring-${highlighted?.id}`} coordinate={{ latitude: ring.lat, longitude: ring.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} testID="map-highlight">
              <View style={{ width: 44, height: 44, borderRadius: 22, borderWidth: 3, borderColor: RING, backgroundColor: 'rgba(255,255,255,0.25)' }} />
            </Marker>
          ) : null}
        </MapView>
        <Legend />
      </View>
    );
  }

  return (
    <View testID={testID} style={{ gap: t.space.sm }}>
      {body}
      {highlighted ? (
        <Text variant="footnote" tone="muted" testID="map-highlight-caption" accessibilityLiveRegion="polite">
          {highlightCaption(highlighted)}
        </Text>
      ) : null}
    </View>
  );
}
