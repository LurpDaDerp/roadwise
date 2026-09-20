import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { TripEventView } from '@/data/queries';
import type { LatLng } from '@/lib/geo';
import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { measuredLine, regionFor, routeSegments, type RouteSegment } from './detail';
import { Field } from './Field';
import { ICON, TOUCH } from './layout';

/**
 * The route map (§7.D D2), and the rule that governs it: **the map is never the only way to read
 * the drive.** The timeline underneath carries every event with its time, its measurement and its
 * points, so this whole section can be absent — offline, without a native maps module, without a
 * saved route — and nothing is lost but a picture.
 *
 * Consequences of that rule, each of which is why a line below looks the way it does:
 *
 * - `react-native-maps` is loaded with `require` at *render* time, not imported at module scope.
 *   The package reaches for a TurboModule the moment it is evaluated, which throws in Expo Go,
 *   in a build made before the native module landed, and under Jest. Catching that here turns
 *   three different absences into one honest state instead of a crash.
 * - The map is hidden from assistive technology. A screen reader is given the timeline, which
 *   says everything the pins do in words; a map that announced "Google Map" and nothing else
 *   would be noise between two useful headings.
 * - The route is drawn in **two inks and two patterns**: solid ID blue within the limit, dashed
 *   stamp magenta where a speeding episode was recorded (§14: never colour alone). The legend
 *   under the map names both, so the pattern is readable without the map.
 */
export type MapsModule = typeof import('react-native-maps');

let cached: MapsModule | null | undefined;

/**
 * The native maps module, or null when this build has none. Cached across renders — including the
 * failure, so a device without the module pays for one throw and not one per frame.
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

/** Test seam: forget what `loadMaps` cached, so a suite can mount both halves of the branch. */
export function resetMapsCache(): void {
  cached = undefined;
}

const MAP_HEIGHT = 220;
const ROUTE_WIDTH = 5;
/** The dash the over-limit stretches are drawn with: long enough to read at a glance. */
const OVER_DASH: number[] = [12, 8];

function Legend() {
  const th = useTheme();
  const row = (ink: string, dashed: boolean, label: string) => (
    <View
      key={label}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}
    >
      <View style={{ flexDirection: 'row', gap: dashed ? 3 : 0 }}>
        {(dashed ? [0, 1, 2] : [0]).map((i) => (
          <View
            key={i}
            style={{
              width: dashed ? 6 : 24,
              height: 3,
              borderRadius: 2,
              backgroundColor: ink,
            }}
          />
        ))}
      </View>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
      {row(th.colors.accent, false, copy.detail.legendNormal)}
      {row(th.colors.stamp, true, copy.detail.legendOver)}
    </View>
  );
}

/** The words shown where a map cannot be: always a reason, never an empty grey box. */
function NoMap({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const th = useTheme();
  return (
    <View
      testID={testID}
      style={{
        gap: th.space.xs,
        padding: th.space.lg,
        borderRadius: th.radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: th.colors.border,
        backgroundColor: th.colors.surfaceRaised,
      }}
    >
      <Text variant="subhead">{title}</Text>
      <Text variant="footnote" tone="muted">
        {body}
      </Text>
    </View>
  );
}

function MapCanvas({
  segments,
  pins,
  points,
  testID,
}: {
  segments: readonly RouteSegment[];
  pins: readonly TripEventView[];
  points: readonly LatLng[];
  testID?: string;
}) {
  const th = useTheme();
  const maps = loadMaps();
  const region = regionFor(points);
  if (maps === null || region === null) {
    return <NoMap title={copy.detail.noMap} body={copy.detail.noMapBody} testID="map-unavailable" />;
  }
  const MapView = maps.default;
  const { Marker, Polyline } = maps;

  return (
    <View
      testID={testID}
      // The timeline says everything the pins do, in words and in order; a screen reader is not
      // sent through a map it cannot read (§7.D D2 a11y).
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: MAP_HEIGHT,
        borderRadius: th.radius.md,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: th.colors.border,
      }}
    >
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        pointerEvents="none"
        toolbarEnabled={false}
        showsUserLocation={false}
        showsMyLocationButton={false}
      >
        {segments.map((segment, index) => (
          <Polyline
            key={index}
            coordinates={segment.points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
            strokeWidth={ROUTE_WIDTH}
            strokeColor={segment.over ? th.colors.stamp : th.colors.accent}
            lineDashPattern={segment.over ? OVER_DASH : undefined}
          />
        ))}
        {pins.map((event) => (
          <Marker
            key={event.id}
            coordinate={{ latitude: event.lat ?? 0, longitude: event.lng ?? 0 }}
            title={measuredLine(event)}
            pinColor={th.colors.stamp}
          />
        ))}
      </MapView>
    </View>
  );
}

/**
 * The collapsible ROUTE field on D2. Collapsed, it is one line and a control; expanded, it is the
 * map, its legend and the trimming note.
 *
 * `online` is a prop rather than something read here: M2 ships no network module, so the honest
 * default is "assume the tiles will load" and the driver's own Hide control is the escape on a
 * dead connection. The day a network adapter lands, one caller passes it and the offline copy
 * below is already written and already tested.
 */
export function TripRouteField({
  points,
  events,
  hasRoute,
  online = true,
  initiallyOpen = true,
  testID,
}: {
  points: readonly LatLng[];
  events: readonly TripEventView[];
  /** The trip stored a polyline at all. False means the trace has aged out (§18.4). */
  hasRoute: boolean;
  online?: boolean;
  initiallyOpen?: boolean;
  testID?: string;
}) {
  const th = useTheme();
  const [open, setOpen] = useState(initiallyOpen);
  const pins = events.filter((event) => event.lat !== null && event.lng !== null);
  const segments = routeSegments(points, events);

  const body = (): React.ReactNode => {
    if (!hasRoute || points.length < 2) {
      return <NoMap title={copy.detail.noRoute} body={copy.detail.noRouteBody} testID="no-route" />;
    }
    if (!online) {
      return <NoMap title={copy.detail.noMap} body={copy.detail.offline} testID="map-offline" />;
    }
    return (
      <>
        <MapCanvas segments={segments} pins={pins} points={points} testID="map-canvas" />
        <Legend />
        <Text variant="caption" tone="subtle">
          {copy.detail.trimmed}
        </Text>
      </>
    );
  };

  return (
    <Field label={copy.detail.routeLabel} testID={testID}>
      <View style={{ gap: th.space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? copy.detail.hideMap : copy.detail.showMap}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          hitSlop={th.space.xs}
          testID="map-toggle"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space.xs,
            alignSelf: 'flex-start',
            minHeight: TOUCH,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={ICON.md}
            color={th.colors.accent}
          />
          <Text variant="subhead" tone="accent">
            {open ? copy.detail.hideMap : copy.detail.showMap}
          </Text>
        </Pressable>
        {open ? body() : null}
      </View>
    </Field>
  );
}

/**
 * The mini-map on D3: where this one moment happened. Same loader, same absence handling, no
 * route — one pin, because the question on that screen is "was this really me, here".
 */
export function EventMiniMap({ event, testID }: { event: TripEventView; testID?: string }) {
  if (event.lat === null || event.lng === null) return null;
  const point: LatLng = { lat: event.lat, lng: event.lng };
  return <MapCanvas segments={[]} pins={[event]} points={[point]} testID={testID} />;
}
