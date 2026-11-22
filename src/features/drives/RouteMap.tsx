import { Ionicons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, useColorScheme, View, type LayoutChangeEvent } from 'react-native';
import type MapViewType from 'react-native-maps';

import { useUnits } from '@/data/queries/units';
import { PLACE_ICON, type FixedKind } from '@/features/places/model';
import { googleMapKeyMissing } from '@/features/settings/maps';
import { androidMapLook } from '@/features/settings/mapStyle';
import type { LatLng } from '@/lib/geo';
import type { Units } from '@/lib/units';
import { IconButton, Text, tokens, useTheme } from '@/ui';

import { EventIcon } from './EventIcon';
import { DASHPAL_MARK, EVENT_LABEL, eventKind, eventName, formatClock, formatEventDuration, pickupDetail, spokenEventDuration, spokenRoute, TIER_SIGNAL } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';
import { PIN, PIN_PLACE, START, StartDisc, TeardropPin, useSettling } from './Pin';
import {
  allPoints,
  awayFrom,
  eventMarks,
  markShape,
  metersPerPixel,
  MIN_MARK_PX,
  regionFor,
  sameZoom,
  screenOffset,
  tipAnchor,
  type EventMark,
  type Lead,
  type Region,
  type Runs,
} from './route';
import { RouteSketch } from './RouteSketch';

export type MapsModule = typeof import('react-native-maps');

let cached: MapsModule | null | undefined;

/**
 * The native maps module, or null when this build has none (Expo Go, Jest, an old dev build) or
 * is an Android build with no Google Maps key (`googleMapKeyMissing`: Google's SDK would end the
 * app on the first map). Required at render time, not imported, because the package reaches for
 * its native module the moment it is evaluated. The failure is cached too, so a build without it
 * pays for one throw.
 */
export function loadMaps(): MapsModule | null {
  if (googleMapKeyMissing()) return null;
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
 * Map tiles follow the system appearance, not the app's scheme (Apple's map by itself; Google's on
 * Android through `androidMapLook`), so the route inks are pinned to the light palette's signal
 * fills: strong enough on both light and dark tiles. Every pin also
 * carries its event's icon, so no mark relies on colour alone.
 */
const INK = tokens.color.light.signal;
const PAPER = tokens.color.light.surface;
/**
 * The highlight ring's own blue, fixed whatever the theme: at least 3:1 on the light tiles
 * (#F9F5ED 3.76, white 4.08) and the dark ones (#242424 3.80, #2B2B2B 3.47), which the theme's
 * accent is not.
 */
export const RING_INK = '#2F7BEA';
const ROUTE_WIDTH = 5;
/** The dashed lead-in from where the drive began to the route: thinner than the route, 4 pt dashes 6 pt apart. */
const LEAD_WIDTH = 3;
export const LEAD_DASH = [4, 6];
const TIER_Z: Record<Tier, number> = { minor: 1, moderate: 2, severe: 3 };
/**
 * The drive's two ends wear the app's ink (light `primary`, #111113) with white: apart from the
 * tier colours, the green route and the blue ring, white-rimmed so they hold on dark tiles too.
 * They sit over the route and the event stretches and dots, under the ring and the event pins, so
 * a pin at either end is still the one a tap reaches. The destination draws over the start.
 */
export const END_INK = tokens.color.light.primary;
export const END_ON = tokens.color.light.onPrimary;
export const START_Z = 5;
export const END_Z = 6;
/** The white dot in the head of the destination pin when the end is no saved Home, Work or School. */
export const END_DOT = 10;
/** A saved place's icon in the start disc and the destination pin's head (the pins' glyph size). */
const PLACE_GLYPH = 16;
/** The start disc's placement: centred on its point on both map engines. */
export const START_PLACE = { anchor: { x: 0.5, y: 0.5 }, centerOffset: { x: 0, y: 0 } } as const;
/** How long Recenter takes to bring the map back to the view it opened on. */
export const RECENTER_MS = 300;

/** The teardrop pin and its placement (`./Pin`), kept exported here for the map's callers. */
export { PIN, PIN_PLACE };

/** The ring around the head of the pin picked in the breakdown: its foot on the pin's tip. */
const RING_D = 44;
const RING_H = RING_D / 2 + (PIN.tipY - PIN.headY);
export const RING_PLACE = tipAnchor(RING_H, RING_H);

/** A tap on the map this soon after a pin tap is the same touch (Apple Maps reports both). */
const SAME_TAP_MS = 400;

/** Singular and plural for the map's spoken summary. */
const SPOKEN: Record<EventType, [string, string]> = {
  speeding: ['speeding', 'speeding'],
  hard_brake: ['hard brake', 'hard brakes'],
  hard_accel: ['hard acceleration', 'hard accelerations'],
  hard_corner: ['hard corner', 'hard corners'],
  phone_pickup: ['phone pickup', 'phone pickups'],
  eyes_off: ['eyes off road', 'eyes off road'],
  drowsy: ['drowsy alert', 'drowsy alerts'],
};

/** What the map knows of the drive's two ends: its "from → to" labels and the saved places they are. */
export type RouteEnds = Pick<LocalDrive, 'fromLabel' | 'toLabel' | 'fromPlace' | 'toPlace'>;

/**
 * The saved place an end's marker shows: Home, Work or School, read from the place stored with the
 * drive (`fromPlace` / `toPlace`, the match that also named its "from → to" line), so the icon and
 * the line always agree. A place of your own, an end that matched none and a restored drive: null.
 */
export function endPlace(id: string | null | undefined): FixedKind | null {
  return id === 'home' || id === 'work' || id === 'school' ? id : null;
}

/**
 * The start disc would sit under the destination pin on screen at this zoom: anywhere a 30 pt disc
 * would touch the 32 × 44 pin standing on `end`. On a drive back to the same saved place the start
 * then shows the plain circle round the pin's tip, and the pin's head alone carries the place;
 * zooming in far enough to part them brings the icon back. False before the map has a scale.
 */
export function startUnderPin(start: LatLng, end: LatLng, metersPerPx: number): boolean {
  const o = screenOffset(end, start, metersPerPx);
  if (o === null) return false;
  const r = START.place / 2;
  return Math.abs(o.x) < PIN.width / 2 + r && o.y > -r && o.y < PIN.tipY + r;
}

/**
 * What the map shows, for a screen reader: "Route map, from Home to Work, 2 hard brakes, 1
 * speeding". The ends are named as the recap's "from → to" line names them, and only when it shows.
 */
export function mapLabel(marks: readonly Pick<EventMark, 'type'>[], ends: RouteEnds | null = null): string {
  const head = ends && (ends.fromLabel !== null || ends.toLabel !== null) ? `Route map, from ${spokenRoute(ends)}` : 'Route map';
  if (marks.length === 0) return `${head}, no events marked`;
  const n = new Map<EventType, number>();
  for (const m of marks) n.set(m.type, (n.get(m.type) ?? 0) + 1);
  return `${head}, ${[...n].map(([type, k]) => `${k} ${SPOKEN[type][k === 1 ? 0 : 1]}`).join(', ')}`;
}

/** A pin for a screen reader: "Hard brake, 2 seconds, moderate", "Phone pickup, in hand 24 seconds, at 38 miles per hour". */
export function pinLabel(e: Pick<LocalDriveEvent, 'type' | 'tier' | 'durationS' | 'measured'>, units: Units = 'mi'): string {
  if (e.type === 'phone_pickup') return `${EVENT_LABEL[e.type]}, ${pickupDetail(e, units).spoken}`;
  const kind = eventKind(e.type, e.tier);
  const tail = kind === null ? '' : `, ${kind === DASHPAL_MARK ? kind : kind.toLowerCase()}`;
  return `${EVENT_LABEL[e.type]}, ${spokenEventDuration(e.durationS)}${tail}`;
}

/** The second line of a pin's card: "Lasted 2 s · Moderate · 7:42 AM", or a pickup's "In hand 24 s · 38 mph · 7:42 AM". */
export function eventDetail(e: Pick<LocalDriveEvent, 'type' | 'tier' | 'durationS' | 'startedAt' | 'measured'>, units: Units = 'mi'): string {
  if (e.type === 'phone_pickup') return `${pickupDetail(e, units).text} · ${formatClock(e.startedAt)}`;
  return [`Lasted ${formatEventDuration(e.durationS)}`, eventKind(e.type, e.tier), formatClock(e.startedAt)].filter(Boolean).join(' · ');
}

/** A map pin in its tier's colour with the event's icon, its tip on the spot. */
function Pin({ mark }: { mark: EventMark }) {
  const ink = INK[TIER_SIGNAL[mark.tier]];
  return (
    <TeardropPin fill={ink.fill} edge={PAPER}>
      <EventIcon type={mark.type} size={16} color={ink.onFill} />
    </TeardropPin>
  );
}

/**
 * Where the drive began: Google Maps' origin circle, a white disc with an ink ring (20 pt), or for
 * a saved Home, Work or School a 30 pt disc with the place's icon in ink in its face.
 */
function StartMarker({ place }: { place: FixedKind | null }) {
  return (
    <StartDisc ring={END_INK} face={PAPER} size={place ? START.place : START.plain} testID="map-start-view">
      {place ? <Ionicons name={PLACE_ICON[place]} size={PLACE_GLYPH} color={END_INK} /> : null}
    </StartDisc>
  );
}

/**
 * Where the drive ended: the teardrop pin in ink with a white rim, its tip on the spot, a white dot
 * in its head, or a saved Home, Work or School's icon in white.
 */
function EndMarker({ place }: { place: FixedKind | null }) {
  return (
    <TeardropPin fill={END_INK} edge={PAPER} testID="map-end-view">
      {place ? (
        <Ionicons name={PLACE_ICON[place]} size={PLACE_GLYPH} color={END_ON} />
      ) : (
        <View testID="map-end-dot" style={{ width: END_DOT, height: END_DOT, borderRadius: END_DOT / 2, backgroundColor: END_ON }} />
      )}
    </TeardropPin>
  );
}

/** The small card a tapped pin opens over the bottom of the map: what happened and for how long. */
function EventCard({ event: e, onClose }: { event: LocalDriveEvent; onClose: () => void }) {
  const t = useTheme();
  const units = useUnits();
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
        <EventIcon type={e.type} size={18} color={ink.onFill} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="headline" testID="map-event-title">
          {EVENT_LABEL[e.type]}
        </Text>
        <Text variant="subhead" tone="muted" testID="map-event-detail">
          {eventDetail(e, units)}
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
 * The route map on the summary: a square, a plain base map with the route in green, and every
 * event as a teardrop pin with its icon, its tip on the spot where it happened, the stretch of
 * route it covered drawn in its tier's colour (yellow, orange, red) — or a dot of that colour when
 * the stretch is too short to see at the current zoom. Severe marks sit on top. Tapping a pin
 * opens a small card over the map with the event, how long it lasted, its tier and time; the
 * close button or a tap elsewhere on the map shuts it. A ring circles the event tapped in the
 * breakdown. Pinch, double-tap and drag zoom and pan the map freely (no rotating or tilting); once
 * it is off the view it opened on, which frames the whole route, a Recenter button in its corner
 * brings that view back. The route comes as its runs (the whole route is one; a trimmed one,
 * restored from the server, has one per stretch between privacy cuts) and each is drawn apart: no
 * line joins one run to the next across a cut. With a `lead`-in (`leadIn`: the drive began 30 m or
 * more before its first fix), a dashed line in the route's green runs from where it began to the
 * route, framed with it. The drive's ends are marked: a round start marker where it began (the
 * lead-in's start, else the route's first point) and an ink teardrop pin with its tip on the
 * route's last point, each with the icon of a saved Home, Work or School (`ends`, `endPlace`);
 * on a drive back to the same saved place, a start under the pin on screen stays the plain circle
 * (`startUnderPin`). Event pins draw over both ends, so a pin at either end keeps its tap.
 */
export function RouteMap({
  runs: visible,
  lead = null,
  ends = null,
  events,
  highlighted,
  testID = 'route-map',
}: {
  runs: Runs;
  /** The dashed lead-in from where the drive began (`leadIn`), or null. */
  lead?: Lead | null;
  /** The drive's "from → to" labels and stored places: the end markers' icons and the spoken summary. */
  ends?: RouteEnds | null;
  events: readonly LocalDriveEvent[];
  highlighted: LocalDriveEvent | null;
  testID?: string;
}) {
  const t = useTheme();
  const units = useUnits();
  const [side, setSide] = useState(0);
  const points = useMemo(() => allPoints(visible), [visible]);
  const marks = useMemo(() => eventMarks(visible, events), [visible, events]);
  // The view frames the lead-in too, so the dashed line from where the drive began shows whole.
  const region = useMemo(() => regionFor(lead && points.length >= 2 ? [...points, lead[0]] : points), [points, lead]);
  // The ends of what is drawn: where the drive began (the lead-in's start, else the first drawn
  // run's first point) and the last drawn run's last point. A lone fix is never drawn, so never an end.
  const [startAt, endAt] = useMemo(() => {
    const drawn = visible.filter((r) => r.length >= 2);
    const first = drawn[0];
    const last = drawn[drawn.length - 1];
    return [lead ? lead[0] : (first?.[0] ?? null), last ? (last[last.length - 1] ?? null) : null] as const;
  }, [visible, lead]);
  const fromPlace = endPlace(ends?.fromPlace);
  const toPlace = endPlace(ends?.toPlace);
  /** Where the map was last left, with the fitted region it belongs to (a new route starts over). */
  const [view, setView] = useState<{ base: Region; at: Region } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The map has been dragged or zoomed off the view it opened on: Recenter shows. */
  const [away, setAway] = useState(false);
  const lastPinTap = useRef(0);
  const mapRef = useRef<MapViewType>(null);
  const maps = loadMaps();
  // Android: Google's map takes the system appearance only when it is made, so it is given it (and
  // the quiet style Apple's map gets from showsPointsOfInterests) and remade when it changes.
  const look = androidMapLook(useColorScheme() === 'dark' ? 'dark' : 'light');
  const ring = highlighted && highlighted.lat !== null && highlighted.lng !== null ? { lat: highlighted.lat, lng: highlighted.lng } : null;
  const shown = view && region && view.base === region ? view.at : region;
  const mPerPx = shown ? metersPerPixel(shown, side) : 0;
  const shapes = marks.map((m) => (m.stretch.length >= 2 && markShape(m.lengthM, mPerPx) === 'line' ? 'line' : 'dot'));
  // A drive back to the same saved place: the pin's head carries it, the start under it is plain.
  // Any other start keeps its icon, partly under the pin if need be, so the place is never lost.
  const startIcon = fromPlace && fromPlace === toPlace && startAt && endAt && startUnderPin(startAt, endAt, mPerPx) ? null : fromPlace;
  const settling = useSettling(`${side > 0}|${marks.map((m, i) => `${m.id}:${shapes[i]}`).join(',')}|${ring ? highlighted?.id : ''}|${startIcon}|${toPlace}`);
  const selected = selectedId && marks.some((m) => m.id === selectedId) ? (events.find((e) => e.id === selectedId) ?? null) : null;
  const onLayout = (e: LayoutChangeEvent) => setSide(Math.round(e.nativeEvent.layout.width));

  const frame = {
    borderRadius: t.radius.card,
    borderCurve: 'continuous' as const,
    overflow: 'hidden' as const,
    backgroundColor: t.colors.surfaceRaised,
  };
  const square = [frame, { width: '100%' as const, aspectRatio: 1 }];
  const summary = { accessibilityRole: 'image' as const, accessibilityLabel: mapLabel(marks, ends) };
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
        <View {...hidden}>{side > 32 ? <RouteSketch runs={visible} lead={lead} size={side - 32} strokeWidth={4} background="transparent" /> : null}</View>
      </View>
    );
  } else {
    const MapView = maps.default;
    const { Marker, Polyline } = maps;
    const coords = (ps: readonly LatLng[]) => ps.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    const clean = INK.clean.fill;
    const onRegionChangeComplete = (r: Region) => {
      setAway(awayFrom(r, region));
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
          key={look?.key}
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          {...(look ? { userInterfaceStyle: look.userInterfaceStyle, customMapStyle: look.customMapStyle } : null)}
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
          {lead ? (
            <Polyline
              key="lead-in"
              testID="route-lead-in"
              coordinates={coords(lead)}
              strokeWidth={LEAD_WIDTH}
              strokeColor={clean}
              lineDashPattern={LEAD_DASH}
              lineCap="round"
              zIndex={0}
            />
          ) : null}
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
          {startAt ? (
            <Marker
              key={`start-${startIcon ?? 'plain'}`}
              testID="map-start"
              coordinate={{ latitude: startAt.lat, longitude: startAt.lng }}
              {...START_PLACE}
              tracksViewChanges={settling}
              zIndex={START_Z}
              {...hidden}
            >
              <StartMarker place={startIcon} />
            </Marker>
          ) : null}
          {endAt ? (
            <Marker
              key={`end-${toPlace ?? 'plain'}`}
              testID="map-end"
              coordinate={{ latitude: endAt.lat, longitude: endAt.lng }}
              {...PIN_PLACE}
              tracksViewChanges={settling}
              zIndex={END_Z}
              {...hidden}
            >
              <EndMarker place={toPlace} />
            </Marker>
          ) : null}
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
                <View
                  testID="map-highlight-ring"
                  style={{ width: RING_D, height: RING_D, borderRadius: RING_D / 2, borderWidth: 3, borderColor: RING_INK, backgroundColor: 'rgba(255,255,255,0.25)' }}
                />
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
                accessibilityLabel={e ? pinLabel(e, units) : EVENT_LABEL[m.type]}
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
        {away ? (
          <View style={{ position: 'absolute', top: t.space.md, right: t.space.md }}>
            <IconButton
              icon="scan-outline"
              accessibilityLabel="Recenter map"
              accessibilityHint="Shows the whole route again"
              variant="surface"
              size={40}
              onPress={() => {
                mapRef.current?.animateToRegion(region, RECENTER_MS);
                setAway(false);
              }}
              testID="map-recenter"
            />
          </View>
        ) : null}
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
