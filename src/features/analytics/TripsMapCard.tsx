import { useEffect, useMemo, useRef, useState } from 'react';
import { Text as RNText, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type MapViewType from 'react-native-maps';

import type { ProblemSpot } from '@/data/queries/spots';
import { PIN, PIN_PLACE, TeardropPin, useSettling } from '@/features/drives/Pin';
import { awayFrom } from '@/features/drives/route';
import { RECENTER_MS } from '@/features/drives/RouteMap';
import { loadMaps, type Region } from '@/features/settings/maps';
import { chipText } from '@/features/spots/format';
import { spotInk } from '@/features/spots/ink';
import type { LatLng } from '@/lib/geo';
import { Card, IconButton, Text, useTheme, withAlpha } from '@/ui';

import { analyticsCopy } from './copy';
import type { MapPoint } from './model';

/** The map's height in the card. */
export const TRIPS_MAP_HEIGHT = 320;

/** A spot's road: a 9 pt casing under a 6 pt line of the spot ink, over the 4 pt heat lines. */
export const SPOT_CASING_WIDTH = 9;
export const SPOT_LINE_WIDTH = 6;
/** Draw order on the map: heat lines, then each spot's casing, its line, and its pin (rank 1 on top). */
export const SPOT_Z = { casing: 1, line: 2, marker: (rank: number) => 10 + (6 - rank) } as const;

/** The label chip beside a spot's pin: its middle level with the pin's head. */
const CHIP_H = 22;
const CHIP_TOP = PIN.headY - CHIP_H / 2;
/** The chip starts this far into the pin's right edge (its left edge at x 30). */
const CHIP_TUCK = 2;

/**
 * Whether the map, `aspect` (its width over its height) wide, has been dragged or zoomed off the
 * view that frames every route (`framed`) by more than a tenth: the recap map's `awayFrom`,
 * measured on the span this wider-than-tall map really shows. The engine widens the framing view
 * to the map's shape, so each region's height is scaled to the map's width before the compare.
 */
export function awayOnMap(current: Region, framed: Region, aspect: number): boolean {
  const k = aspect > 0 ? aspect : 1;
  return awayFrom({ ...current, latitudeDelta: current.latitudeDelta * k }, { ...framed, latitudeDelta: framed.latitudeDelta * k });
}

const regionKey = (r: Region | null) => (r ? `${r.latitude},${r.longitude},${r.latitudeDelta},${r.longitudeDelta}` : '');

/**
 * A key per route line drawn from the line itself (its point count, first, middle and last points),
 * so a new drive's lines arriving at the front of the list add overlays and leave the others' alone.
 * Lines that share all of those get a running number.
 */
export function routeKeys(routes: readonly (readonly MapPoint[])[]): string[] {
  const seen = new Map<string, number>();
  return routes.map((line) => {
    const at = (i: number) => {
      const p = line[i];
      return p ? `${p.latitude},${p.longitude}` : '';
    };
    const base = `${line.length}|${at(0)}|${at(line.length >> 1)}|${at(line.length - 1)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

const toCoords = (points: readonly LatLng[]) => points.map((p) => ({ latitude: p.lat, longitude: p.lng }));

/** A spot's label chip: a paper pill with the street, else the kind's short word. */
function SpotChip({ spot, ghost = false }: { spot: ProblemSpot; ghost?: boolean }) {
  const t = useTheme();
  return (
    <View
      testID={ghost ? undefined : `spot-chip-${spot.id}`}
      style={{
        marginTop: CHIP_TOP,
        marginLeft: ghost ? 0 : -CHIP_TUCK,
        marginRight: ghost ? -CHIP_TUCK : 0,
        height: CHIP_H,
        paddingHorizontal: 8,
        borderRadius: CHIP_H / 2,
        justifyContent: 'center',
        backgroundColor: t.colors.surface,
        borderWidth: 1,
        borderColor: t.colors.border,
        opacity: ghost ? 0 : 1,
      }}
    >
      <RNText allowFontScaling={false} numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: t.colors.text }}>
        {chipText(spot)}
      </RNText>
    </View>
  );
}

/**
 * A spot's marker: the teardrop in the spot ink with the kind's icon, its chip beside the head.
 * An invisible twin of the chip on the left keeps the view symmetric, so the pin's tip is the
 * view's middle whatever the chip's width and the lone pin's placement holds on both map engines.
 */
function SpotMarkerView({ spot, scheme }: { spot: ProblemSpot; scheme: 'light' | 'dark' }) {
  const ink = spotInk(scheme);
  return (
    <View collapsable={false} style={{ flexDirection: 'row', alignItems: 'flex-start', height: PIN.height }}>
      <SpotChip spot={spot} ghost />
      <TeardropPin fill={ink.line} edge={ink.pinEdge} type={spot.kind} iconColor={ink.onLine} />
      <SpotChip spot={spot} />
    </View>
  );
}

/**
 * Every trip ever, drawn as thin see-through lines so roads driven often build up, with the spots
 * to watch on top: each spot's stretch of road a solid line of the spot ink over a casing, and a
 * pin with the kind's icon and a label chip; tapping a pin opens that spot (`onSpot`). It opens on
 * `fitRegion` (the most-driven roads in the middle) and pans and zooms freely. Once dragged or
 * zoomed off that view by more than a tenth, a Recenter button in its top-right corner takes it
 * back, as on the recap map. Each time the Analytics tab gains focus (`focusCount` goes up) it goes
 * back on its own and the button hides; when the routes' framing view changes it follows only if it
 * was on that view, so a map the driver has moved stays put with Recenter showing. Under Reduce
 * Motion every return jumps instead of gliding. The map itself is hidden from screen readers (the
 * Recenter button is not); the card's title says what it is, and the "Spots to watch" card lists
 * the spots. Without the maps module it says so in a line instead.
 */
export function TripsMapCard({
  routes,
  region,
  spots = [],
  onSpot,
  focusCount = 0,
}: {
  routes: readonly MapPoint[][];
  region: Region | null;
  spots?: readonly ProblemSpot[];
  onSpot?: (id: string) => void;
  /** Goes up each time the Analytics tab gains focus again: the map goes back to the view framing every route. */
  focusCount?: number;
}) {
  const t = useTheme();
  const maps = loadMaps();
  const ink = withAlpha(t.colors.accent, t.scheme === 'dark' ? 0.45 : 0.35);
  const spotLine = spotInk(t.scheme);
  const settling = useSettling(`${t.scheme}|${spots.map((s) => `${s.id}:${s.label ?? ''}`).join(',')}`);
  const lineKeys = useMemo(() => routeKeys(routes), [routes]);
  const mapRef = useRef<MapViewType>(null);
  /** The map has been dragged or zoomed off the view framing every route: Recenter shows. */
  const [away, setAway] = useState(false);
  /** The map's width over its height, once laid out. */
  const [aspect, setAspect] = useState(1);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setAspect(width / height);
  };
  const still = t.reduceMotion;
  const recenter = (to: Region) => {
    mapRef.current?.animateToRegion(to, still ? 0 : RECENTER_MS);
    setAway(false);
  };

  // A tab focus takes the map back to the framing view. New routes framed differently move it only
  // while it sits on the old framing view: one dragged or zoomed off it stays put (Recenter shows
  // and goes to the new view). A map that has only just appeared needs nothing: it opens on that view.
  const key = regionKey(region);
  const framed = useRef({ focus: focusCount, key });
  useEffect(() => {
    const last = framed.current;
    if (last.focus === focusCount && last.key === key) return;
    framed.current = { focus: focusCount, key };
    if (!region || last.key === '') return;
    if (last.focus === focusCount && away) return;
    mapRef.current?.animateToRegion(region, still ? 0 : RECENTER_MS);
    setAway(false);
  }, [away, focusCount, key, region, still]);

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
        <View testID="trips-map-frame" style={{ height: TRIPS_MAP_HEIGHT }} onLayout={onLayout}>
          <View testID="trips-map" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
            <maps.default
              ref={mapRef}
              style={{ flex: 1 }}
              initialRegion={region}
              onRegionChangeComplete={(r: Region) => setAway(awayOnMap(r, region, aspect))}
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
                <maps.Polyline key={lineKeys[i]} coordinates={coords} strokeColor={ink} strokeWidth={4} lineCap="round" lineJoin="round" />
              ))}
              {spots.map((s) =>
                s.segment.length >= 2 ? (
                  <maps.Polyline
                    key={`spot-casing-${s.id}`}
                    testID={`spot-casing-${s.id}`}
                    coordinates={toCoords(s.segment)}
                    strokeColor={spotLine.casing}
                    strokeWidth={SPOT_CASING_WIDTH}
                    lineCap="round"
                    lineJoin="round"
                    zIndex={SPOT_Z.casing}
                  />
                ) : null
              )}
              {spots.map((s) =>
                s.segment.length >= 2 ? (
                  <maps.Polyline
                    key={`spot-line-${s.id}`}
                    testID={`spot-line-${s.id}`}
                    coordinates={toCoords(s.segment)}
                    strokeColor={spotLine.line}
                    strokeWidth={SPOT_LINE_WIDTH}
                    lineCap="round"
                    lineJoin="round"
                    zIndex={SPOT_Z.line}
                  />
                ) : null
              )}
              {spots.map((s) => (
                <maps.Marker
                  key={`spot-pin-${s.id}`}
                  testID={`spot-pin-${s.id}`}
                  coordinate={{ latitude: s.pin.lat, longitude: s.pin.lng }}
                  {...PIN_PLACE}
                  tracksViewChanges={settling}
                  zIndex={SPOT_Z.marker(s.rank)}
                  onPress={() => onSpot?.(s.id)}
                >
                  <SpotMarkerView spot={s} scheme={t.scheme} />
                </maps.Marker>
              ))}
            </maps.default>
          </View>
          {away ? (
            <View style={{ position: 'absolute', top: t.space.md, right: t.space.md }}>
              <IconButton
                icon="scan-outline"
                accessibilityLabel={analyticsCopy.map.recenter}
                accessibilityHint={analyticsCopy.map.recenterHint}
                variant="surface"
                size={40}
                onPress={() => recenter(region)}
                testID="trips-map-recenter"
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
