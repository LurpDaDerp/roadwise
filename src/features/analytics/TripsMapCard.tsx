import { Text as RNText, View } from 'react-native';

import type { ProblemSpot } from '@/data/queries/spots';
import { PIN, PIN_PLACE, TeardropPin, useSettling } from '@/features/drives/Pin';
import { loadMaps, type Region } from '@/features/settings/maps';
import { chipText } from '@/features/spots/format';
import { spotInk } from '@/features/spots/ink';
import type { LatLng } from '@/lib/geo';
import { Card, Text, useTheme, withAlpha } from '@/ui';

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
 * `fitRegion` (the most-driven roads in the middle) and pans and zooms freely. The map itself is
 * hidden from screen readers; the card's title says what it is, and the "Spots to watch" card
 * lists the spots. Without the maps module it says so in a line instead.
 */
export function TripsMapCard({
  routes,
  region,
  spots = [],
  onSpot,
}: {
  routes: readonly MapPoint[][];
  region: Region | null;
  spots?: readonly ProblemSpot[];
  onSpot?: (id: string) => void;
}) {
  const t = useTheme();
  const maps = loadMaps();
  const ink = withAlpha(t.colors.accent, t.scheme === 'dark' ? 0.45 : 0.35);
  const spotLine = spotInk(t.scheme);
  const settling = useSettling(`${t.scheme}|${spots.map((s) => `${s.id}:${chipText(s)}`).join(',')}`);

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
      ) : null}
    </Card>
  );
}
