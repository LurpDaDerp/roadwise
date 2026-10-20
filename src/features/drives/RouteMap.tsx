import { Ionicons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type MapViewType from 'react-native-maps';
import Svg, { Path } from 'react-native-svg';

import type { LatLng } from '@/lib/geo';
import { IconButton, Text, tokens, useTheme } from '@/ui';

import { DASHPAL_MARK, EVENT_ICON, EVENT_LABEL, eventKind, eventName, formatClock, formatEventDuration, spokenEventDuration, TIER_SIGNAL } from './format';
import type { LocalDriveEvent } from './model';
import {
  allPoints,
  eventMarks,
  markShape,
  metersPerPixel,
  MIN_MARK_PX,
  minZoomFor,
  regionFor,
  sameZoom,
  tipAnchor,
  zoomBack,
  type EventMark,
  type MapEngine,
  type Region,
  type Runs,
} from './route';
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
const TIER_Z: Record<Tier, number> = { minor: 1, moderate: 2, severe: 3 };
const ENGINE: MapEngine = Platform.OS === 'android' ? 'google' : 'apple';

/**
 * The pin: a round head tapering to a point, Google Maps style, in a fixed 32 × 44 point view. The
 * tip is 42 points down (the 2 below it hold the drop shadow); the head is a 28-point circle
 * centred 15 points down.
 */
export const PIN = { width: 32, height: 44, tipY: 42, headY: 15, headR: 14 } as const;
const PIN_PATH = 'M16 42 C13.2 35 2 26.5 2 15 A14 14 0 1 1 30 15 C30 26.5 18.8 35 16 42 Z';
export const PIN_PLACE = tipAnchor(PIN.height, PIN.tipY);

/** The ring around the head of the pin picked in the breakdown: its foot on the pin's tip. */
const RING_D = 44;
const RING_H = RING_D / 2 + (PIN.tipY - PIN.headY);
export const RING_PLACE = tipAnchor(RING_H, RING_H);

/** A tap on the map this soon after a pin tap is the same touch (Apple Maps reports both). */
const SAME_TAP_MS = 400;
/** How long a newly drawn custom marker keeps redrawing before it is frozen (Android snapshots). */
const SETTLE_MS = 800;

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

/** A pin for a screen reader: "Hard brake, 2 seconds, moderate". */
export function pinLabel(e: Pick<LocalDriveEvent, 'type' | 'tier' | 'durationS'>): string {
  const kind = eventKind(e.type, e.tier);
  const tail = kind === null ? '' : `, ${kind === DASHPAL_MARK ? kind : kind.toLowerCase()}`;
  return `${EVENT_LABEL[e.type]}, ${spokenEventDuration(e.durationS)}${tail}`;
}

/** The second line of a pin's card: "Lasted 2 s · Moderate · 7:42 AM". */
export function eventDetail(e: Pick<LocalDriveEvent, 'type' | 'tier' | 'durationS' | 'startedAt'>): string {
  return [`Lasted ${formatEventDuration(e.durationS)}`, eventKind(e.type, e.tier), formatClock(e.startedAt)].filter(Boolean).join(' · ');
}

/** A map pin in its tier's colour with the event's icon, its tip on the spot. */
function Pin({ mark }: { mark: EventMark }) {
  const ink = INK[TIER_SIGNAL[mark.tier]];
  return (
    <View collapsable={false} style={{ width: PIN.width, height: PIN.height }}>
      <Svg width={PIN.width} height={PIN.height} viewBox={`0 0 ${PIN.width} ${PIN.height}`} style={StyleSheet.absoluteFill}>
        <Path d={PIN_PATH} fill="#000000" fillOpacity={0.22} transform="translate(0 1.5)" />
        <Path d={PIN_PATH} fill={ink.fill} stroke={PAPER} strokeWidth={1.5} strokeLinejoin="round" />
      </Svg>
      <View
        style={{
          position: 'absolute',
          left: PIN.width / 2 - PIN.headR,
          top: PIN.headY - PIN.headR,
          width: PIN.headR * 2,
          height: PIN.headR * 2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={EVENT_ICON[mark.type]} size={16} color={ink.onFill} />
      </View>
    </View>
  );
}

/** The small card a tapped pin opens over the bottom of the map: what happened and for how long. */
function EventCard({ event: e, onClose }: { event: LocalDriveEvent; onClose: () => void }) {
  const t = useTheme();
  const ink = INK[TIER_SIGNAL[e.tier]];
  return (
    <View
      testID="map-event-card"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: t.space.md,
        right: t.space.md,
        bottom: t.space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.md,
        paddingVertical: t.space.sm,
        paddingLeft: t.space.md,
        paddingRight: t.space.xs,
        borderRadius: t.radius.lg,
        borderCurve: 'continuous',
        backgroundColor: t.colors.surface,
        borderWidth: t.scheme === 'dark' ? 1 : 0,
        borderColor: t.colors.border,
        boxShadow: t.elevation.raised,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: ink.fill, alignItems: 'center', justifyContent: 'center' }}
      >
        <Ionicons name={EVENT_ICON[e.type]} size={18} color={ink.onFill} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="headline" testID="map-event-title">
          {EVENT_LABEL[e.type]}
        </Text>
        <Text variant="subhead" tone="muted" testID="map-event-detail">
          {eventDetail(e)}
        </Text>
      </View>
      <IconButton icon="close" variant="plain" size={36} accessibilityLabel="Close event details" onPress={onClose} testID="map-event-close" />
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
 * True while custom markers drawn for `key` may still be painting: they redraw for a moment, then
 * freeze, so Android's marker snapshot holds the finished pin and the map stays cheap afterwards.
 */
function useSettling(key: string): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return settled !== key;
}

/**
 * The route map on the summary: a square, a plain base map with the route in green, and every
 * event as a teardrop pin with its icon, its tip on the spot where it happened, the stretch of
 * route it covered drawn in its tier's colour (yellow, orange, red) — or a dot of that colour when
 * the stretch is too short to see at the current zoom. Severe marks sit on top. Tapping a pin
 * opens a small card over the map with the event, how long it lasted, its tier and time; the
 * close button or a tap elsewhere on the map shuts it. A ring circles the event tapped in the
 * breakdown. Pinch, double-tap and drag zoom and pan the map, but it never zooms out past the view
 * it opens on, which frames the whole route; it doesn't rotate or tilt. The route comes as its
 * visible runs and each is drawn apart: no line joins one run to the next across a privacy cut.
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
  /** Where the map was last left, with the fitted region it belongs to (a new route starts over). */
  const [view, setView] = useState<{ base: Region; at: Region } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastPinTap = useRef(0);
  const mapRef = useRef<MapViewType>(null);
  const maps = loadMaps();
  const ring = highlighted && highlighted.lat !== null && highlighted.lng !== null ? { lat: highlighted.lat, lng: highlighted.lng } : null;
  const shown = view && region && view.base === region ? view.at : region;
  const mPerPx = shown ? metersPerPixel(shown, side) : 0;
  const shapes = marks.map((m) => (m.stretch.length >= 2 && markShape(m.lengthM, mPerPx) === 'line' ? 'line' : 'dot'));
  const settling = useSettling(`${side > 0}|${marks.map((m, i) => `${m.id}:${shapes[i]}`).join(',')}|${ring ? highlighted?.id : ''}`);
  const selected = selectedId && marks.some((m) => m.id === selectedId) ? (events.find((e) => e.id === selectedId) ?? null) : null;
  const onLayout = (e: LayoutChangeEvent) => setSide(Math.round(e.nativeEvent.layout.width));

  const frame = {
    borderRadius: t.radius.card,
    borderCurve: 'continuous' as const,
    overflow: 'hidden' as const,
    backgroundColor: t.colors.surfaceRaised,
  };
  const square = [frame, { width: '100%' as const, aspectRatio: 1 }];
  const summary = { accessibilityRole: 'image' as const, accessibilityLabel: mapLabel(marks) };
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
      <View style={[square, { alignItems: 'center', justifyContent: 'center' }]} testID="map-unavailable" onLayout={onLayout} accessible {...summary}>
        <View {...hidden}>{side > 32 ? <RouteSketch runs={visible} size={side - 32} strokeWidth={4} background="transparent" /> : null}</View>
      </View>
    );
  } else {
    const MapView = maps.default;
    const { Marker, Polyline } = maps;
    const coords = (ps: readonly LatLng[]) => ps.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    const clean = INK.clean.fill;
    const onRegionChangeComplete = (r: Region) => {
      const back = zoomBack(r, region);
      if (back) mapRef.current?.animateToRegion(back, 250);
      setView((cur) => (cur && cur.base === region && sameZoom(cur.at, r) ? cur : { base: region, at: r }));
    };
    const onMapPress = (e: { nativeEvent: { action?: string } }) => {
      if (e.nativeEvent.action === 'marker-press' || Date.now() - lastPinTap.current < SAME_TAP_MS) return;
      setSelectedId(null);
    };
    body = (
      <View style={square} testID="map-canvas" onLayout={onLayout}>
        {/* One spoken summary of the map; each pin is its own button after it. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none" accessible testID="map-summary" {...summary} />
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          minZoomLevel={minZoomFor(region, side, ENGINE)}
          onRegionChangeComplete={onRegionChangeComplete}
          onPress={onMapPress}
          scrollEnabled
          zoomEnabled
          zoomTapEnabled
          rotateEnabled={false}
          pitchEnabled={false}
          zoomControlEnabled={false}
          toolbarEnabled={false}
          moveOnMarkerPress={false}
          showsUserLocation={false}
          showsPointsOfInterests={false}
          showsCompass={false}
        >
          {visible.map((run, i) =>
            run.length >= 2 ? (
              <Polyline key={`run-${i}`} coordinates={coords(run)} strokeWidth={ROUTE_WIDTH} strokeColor={clean} lineCap="round" lineJoin="round" zIndex={0} />
            ) : null
          )}
          {marks.map((m, i) => {
            const ink = INK[TIER_SIGNAL[m.tier]].fill;
            if (shapes[i] === 'line') {
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
                tracksViewChanges={settling}
                zIndex={TIER_Z[m.tier]}
                {...hidden}
              >
                <View collapsable={false} style={{ width: MIN_MARK_PX, height: MIN_MARK_PX, borderRadius: MIN_MARK_PX / 2, backgroundColor: ink }} />
              </Marker>
            );
          })}
          {ring ? (
            <Marker
              key={`ring-${highlighted?.id}`}
              coordinate={{ latitude: ring.lat, longitude: ring.lng }}
              {...RING_PLACE}
              tracksViewChanges={settling}
              // Under the pins, so the pin it circles stays the one a tap reaches.
              zIndex={9}
              testID="map-highlight"
              {...hidden}
            >
              <View collapsable={false} style={{ width: RING_D, height: RING_H }}>
                <View style={{ width: RING_D, height: RING_D, borderRadius: RING_D / 2, borderWidth: 3, borderColor: RING, backgroundColor: 'rgba(255,255,255,0.25)' }} />
              </View>
            </Marker>
          ) : null}
          {marks.map((m) => {
            const e = events.find((x) => x.id === m.id);
            return (
              <Marker
                key={`pin-${m.id}`}
                testID={`pin-${m.id}`}
                coordinate={{ latitude: m.at.lat, longitude: m.at.lng }}
                {...PIN_PLACE}
                tracksViewChanges={settling}
                zIndex={m.id === selectedId ? 20 : 10 + TIER_Z[m.tier]}
                accessible
                accessibilityRole="button"
                accessibilityLabel={e ? pinLabel(e) : EVENT_LABEL[m.type]}
                onPress={() => {
                  lastPinTap.current = Date.now();
                  setSelectedId(m.id);
                }}
              >
                <Pin mark={m} />
              </Marker>
            );
          })}
        </MapView>
        {selected ? <EventCard event={selected} onClose={() => setSelectedId(null)} /> : null}
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
