import { Ionicons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';
import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import type { LatLng } from '@/lib/geo';
import { Text, tokens, useTheme } from '@/ui';

import { EVENT_ICON, eventName, formatClock, TIER_SIGNAL } from './format';
import type { LocalDriveEvent } from './model';
import { allPoints, eventMarks, markShape, metersPerPixel, MIN_MARK_PX, regionFor, type EventMark, type Runs } from './route';
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

/**
 * Map tiles follow the system appearance, not the app's scheme, so the route inks are pinned to
 * the light palette's signal fills: strong enough on both light and dark tiles. Every pin also
 * carries its event's icon, so no mark relies on colour alone.
 */
const INK = tokens.color.light.signal;
const PAPER = tokens.color.light.surface;
const RING = tokens.color.light.accent;
const ROUTE_WIDTH = 5;
const PIN = 28;
const PIN_TIP = 8;
const TIER_Z: Record<Tier, number> = { minor: 1, moderate: 2, severe: 3 };

/** Singular and plural for the map's spoken summary. */
const SPOKEN: Record<EventType, [string, string]> = {
  speeding: ['speeding', 'speeding'],
  hard_brake: ['hard brake', 'hard brakes'],
  hard_accel: ['hard acceleration', 'hard accelerations'],
  hard_corner: ['hard corner', 'hard corners'],
  phone_pickup: ['phone pickup', 'phone pickups'],
  phone_handling: ['phone handling', 'phone handling'],
  eyes_off: ['eyes off road', 'eyes off road'],
  drowsy: ['drowsy alert', 'drowsy alerts'],
};

/** What the map shows, for a screen reader: "Route map, 2 hard brakes, 1 speeding". */
export function mapLabel(marks: readonly Pick<EventMark, 'type'>[]): string {
  if (marks.length === 0) return 'Route map, no events marked';
  const n = new Map<EventType, number>();
  for (const m of marks) n.set(m.type, (n.get(m.type) ?? 0) + 1);
  return `Route map, ${[...n].map(([type, k]) => `${k} ${SPOKEN[type][k === 1 ? 0 : 1]}`).join(', ')}`;
}

/** A map pin in its tier's colour with the event's icon, its tip on the spot. */
function Pin({ mark }: { mark: EventMark }) {
  const ink = INK[TIER_SIGNAL[mark.tier]];
  return (
    <View style={{ alignItems: 'center' }}>
      <View
        style={{
          width: PIN,
          height: PIN,
          borderRadius: PIN / 2,
          backgroundColor: ink.fill,
          borderWidth: 2,
          borderColor: PAPER,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={EVENT_ICON[mark.type]} size={15} color={ink.onFill} />
      </View>
      <View
        style={{
          marginTop: -1,
          width: 0,
          height: 0,
          borderLeftWidth: PIN_TIP / 2 + 1,
          borderRightWidth: PIN_TIP / 2 + 1,
          borderTopWidth: PIN_TIP,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: ink.fill,
        }}
      />
    </View>
  );
}

/** The words under the map for the event tapped in the breakdown. */
export function highlightCaption(e: LocalDriveEvent): string {
  const what = `${eventName(e.type, e.tier)} at ${formatClock(e.startedAt)}`;
  return e.lat === null || e.lng === null
    ? `${what} is hidden for privacy, so it isn't on the map.`
    : `Circled on the map: ${what}`;
}

/**
 * The route map on the summary: a square, a plain base map with the route in green, and every
 * event as a pin with its icon where it happened, the stretch of route it covered drawn in its
 * tier's colour (yellow, orange, red) — or a dot of that colour when the stretch is too short to
 * see at this zoom. Severe marks sit on top. A ring circles the event tapped in the breakdown. The
 * route comes as its visible runs and each is drawn apart: no line joins one run to the next
 * across a privacy cut. Static: it never steals the page scroll. A screen reader hears one summary
 * of the events; the breakdown lists each in words, and the caption below says what is circled.
 */
export function RouteMap({
  runs: visible,
  events,
  highlighted,
  testID = 'route-map',
}: {
  runs: Runs;
  events: readonly LocalDriveEvent[];
  highlighted: LocalDriveEvent | null;
  testID?: string;
}) {
  const t = useTheme();
  const [side, setSide] = useState(0);
  const points = useMemo(() => allPoints(visible), [visible]);
  const marks = useMemo(() => eventMarks(visible, events), [visible, events]);
  const region = useMemo(() => regionFor(points), [points]);
  const maps = loadMaps();
  const ring = highlighted && highlighted.lat !== null && highlighted.lng !== null ? { lat: highlighted.lat, lng: highlighted.lng } : null;
  const mPerPx = region ? metersPerPixel(region, side) : 0;
  const onLayout = (e: LayoutChangeEvent) => setSide(Math.round(e.nativeEvent.layout.width));

  const frame = {
    borderRadius: t.radius.card,
    borderCurve: 'continuous' as const,
    overflow: 'hidden' as const,
    backgroundColor: t.colors.surfaceRaised,
  };
  const square = [frame, { width: '100%' as const, aspectRatio: 1 }];
  const a11y = { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: mapLabel(marks) };
  const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

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
      <View style={[square, { alignItems: 'center', justifyContent: 'center' }]} testID="map-unavailable" onLayout={onLayout} {...a11y}>
        <View {...hidden}>{side > 32 ? <RouteSketch runs={visible} size={side - 32} strokeWidth={4} background="transparent" /> : null}</View>
      </View>
    );
  } else {
    const MapView = maps.default;
    const { Marker, Polyline } = maps;
    const coords = (ps: readonly LatLng[]) => ps.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    const clean = INK.clean.fill;
    body = (
      <View style={square} testID="map-canvas" onLayout={onLayout} {...a11y}>
        <View style={StyleSheet.absoluteFill} {...hidden}>
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
            {visible.map((run, i) =>
              run.length >= 2 ? (
                <Polyline key={`run-${i}`} coordinates={coords(run)} strokeWidth={ROUTE_WIDTH} strokeColor={clean} lineCap="round" lineJoin="round" zIndex={0} />
              ) : null
            )}
            {marks.map((m) => {
              const ink = INK[TIER_SIGNAL[m.tier]].fill;
              if (m.stretch.length >= 2 && markShape(m.lengthM, mPerPx) === 'line') {
                return (
                  <Polyline
                    key={`stretch-${m.id}`}
                    testID={`stretch-${m.id}`}
                    coordinates={coords(m.stretch)}
                    strokeWidth={ROUTE_WIDTH}
                    strokeColor={ink}
                    lineCap="round"
                    lineJoin="round"
                    zIndex={TIER_Z[m.tier]}
                  />
                );
              }
              const at = m.stretch[0] ?? m.at;
              return (
                <Marker
                  key={`dot-${m.id}`}
                  testID={`dot-${m.id}`}
                  coordinate={{ latitude: at.lat, longitude: at.lng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={false}
                  zIndex={TIER_Z[m.tier]}
                >
                  <View style={{ width: MIN_MARK_PX, height: MIN_MARK_PX, borderRadius: MIN_MARK_PX / 2, backgroundColor: ink }} />
                </Marker>
              );
            })}
            {marks.map((m) => (
              <Marker
                key={`pin-${m.id}`}
                testID={`pin-${m.id}`}
                coordinate={{ latitude: m.at.lat, longitude: m.at.lng }}
                anchor={{ x: 0.5, y: 1 }}
                tracksViewChanges={false}
                zIndex={10 + TIER_Z[m.tier]}
              >
                <Pin mark={m} />
              </Marker>
            ))}
            {ring ? (
              <Marker
                key={`ring-${highlighted?.id}`}
                coordinate={{ latitude: ring.lat, longitude: ring.lng }}
                // Its foot on the spot, so it rings the pin's head.
                anchor={{ x: 0.5, y: 1 }}
                tracksViewChanges={false}
                zIndex={20}
                testID="map-highlight"
              >
                <View style={{ width: 44, height: 44, borderRadius: 22, borderWidth: 3, borderColor: RING, backgroundColor: 'rgba(255,255,255,0.25)' }} />
              </Marker>
            ) : null}
          </MapView>
        </View>
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
