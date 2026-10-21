import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import type MapViewType from 'react-native-maps';
import Svg, { Circle, Path } from 'react-native-svg';

import { withAlpha } from '@/ui';

import { thin, type Runs } from './route';
import { loadMaps } from './RouteMap';

/** Where the map backdrop stands: still loading, in the card as an image, or given up on. */
export type MapStatus = 'loading' | 'ready' | 'failed';

/** How long the map has to arrive before the sheet says it couldn't load. */
export const MAP_TIMEOUT_MS = 10_000;

/** A map's edges in degrees. */
export type Bounds = { north: number; south: number; east: number; west: number };
/** A rectangle on the card, in points. */
export type Box = { left: number; top: number; right: number; bottom: number };

/** The narrowest stretch of map the card shows across, in degrees of longitude (about 400 m). */
const MIN_SPAN_DEG = 0.005;
const RAD = Math.PI / 180;
const mercX = (lng: number) => lng * RAD;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
const latOf = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;

/**
 * The edges of a `w` × `h` map (Web Mercator, north up) that holds the route's runs inside `box`,
 * as large as fits and centred there. Only the runs frame it: the raw start and end, trimmed off
 * for privacy, never do. Null when there is no route to draw.
 */
export function shareFrame(runs: Runs, w: number, h: number, box: Box): Bounds | null {
  const pts = runs.filter((r) => r.length >= 2).flat();
  if (pts.length < 2) return null;
  const xs = pts.map((p) => mercX(p.lng));
  const ys = pts.map((p) => mercY(p.lat));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const min = MIN_SPAN_DEG * RAD;
  const s = Math.min((box.right - box.left) / Math.max(maxX - minX, min), (box.bottom - box.top) / Math.max(maxY - minY, min));
  if (!Number.isFinite(s) || !(s > 0)) return null;
  const west = (minX + maxX) / 2 - (box.left + box.right) / 2 / s;
  const north = (minY + maxY) / 2 + (box.top + box.bottom) / 2 / s;
  return { north: latOf(north), south: latOf(north - h / s), west: west / RAD, east: (west + w / s) / RAD };
}

/** The map region a set of edges covers, as react-native-maps takes it. */
export function regionOf(b: Bounds) {
  return {
    latitude: (b.north + b.south) / 2,
    longitude: (b.east + b.west) / 2,
    latitudeDelta: b.north - b.south,
    longitudeDelta: b.east - b.west,
  };
}

/**
 * The route as an SVG path over a `w` × `h` map with edges `b`, through the same Web Mercator
 * projection the map tiles use, so the line sits on the streets. A subpath per run: the pen lifts
 * across a privacy cut. Null when there is nothing to draw.
 */
export function routePath(runs: Runs, b: Bounds, w: number, h: number, max = 240): string | null {
  const drawn = runs.filter((r) => r.length >= 2);
  const total = drawn.reduce((n, r) => n + r.length, 0);
  if (total < 2) return null;
  const x0 = mercX(b.west);
  const sx = w / (mercX(b.east) - x0);
  const y0 = mercY(b.north);
  const sy = h / (y0 - mercY(b.south));
  const parts: string[] = [];
  for (const run of drawn) {
    thin(run, Math.max(2, Math.round((max * run.length) / total))).forEach((p, j) => {
      const x = (mercX(p.lng) - x0) * sx;
      const y = (y0 - mercY(p.lat)) * sy;
      parts.push(`${j === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    });
  }
  return parts.join(' ');
}

/**
 * Whether the share sheet offers "Show map": iOS with the maps module in the build, and a route to
 * frame. Android is frozen for now and shares the plain card.
 */
export function mapOffered(runs: Runs, w: number, h: number, box: Box): boolean {
  return Platform.OS === 'ios' && loadMaps() !== null && shareFrame(runs, w, h, box) !== null;
}

/**
 * The share card's map backdrop: the map of the route's area, a light wash of the card's sky over
 * it, the sky as an opaque band behind the header and the facts (so every line of text keeps the
 * contrast it has on the plain card), and the route in `stroke` on top.
 *
 * How the map gets into the image: `captureRef` cannot be trusted with a live native map view (it
 * often comes out blank or black), so the live map is only a placeholder. Once it is ready, its
 * `takeSnapshot` (MKMapSnapshotter on iOS) renders the exact region this card computed into a PNG;
 * a plain `Image` of that PNG replaces the live map, and the route is drawn over it in SVG with the
 * same Web Mercator projection from the same edges. The captured card then holds only an image and
 * SVG, which `captureRef` draws reliably. The snapshot's own overlays are never relied on.
 */
export function ShareMapBackdrop({
  runs,
  width,
  height,
  box,
  scene,
  stroke,
  strokeWidth,
  band,
  onStatus,
}: {
  runs: Runs;
  width: number;
  height: number;
  /** Where the route goes on the card: clear of the header and the facts. */
  box: Box;
  /** The card's sky stops (top-left → bottom-right). */
  scene: readonly [string, string, string];
  stroke: string;
  strokeWidth: number;
  /** How far the opaque sky reaches down from the top and up from the bottom, and how long each fades. */
  band: { top: number; bottom: number; fade: number };
  onStatus: (s: MapStatus) => void;
}) {
  const maps = loadMaps();
  const bounds = useMemo(() => shareFrame(runs, width, height, box), [runs, width, height, box]);
  const region = useMemo(() => (bounds ? regionOf(bounds) : null), [bounds]);
  const path = useMemo(() => (bounds ? routePath(runs, bounds, width, height) : null), [runs, bounds, width, height]);
  const mapRef = useRef<MapViewType>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [status, setStatus] = useState<MapStatus>('loading');
  /** Settled once, for good; nothing is reported while unmounted (Show map turned off). */
  const settled = useRef(false);
  const alive = useRef(false);
  const report = useRef(onStatus);
  useEffect(() => {
    report.current = onStatus;
  });

  const settle = useCallback((s: Exclude<MapStatus, 'loading'>) => {
    if (settled.current || !alive.current) return;
    settled.current = true;
    setStatus(s);
    report.current(s);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!maps || !region) {
      settle('failed');
      return;
    }
    const timer = setTimeout(() => settle('failed'), MAP_TIMEOUT_MS);
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [maps, region, settle]);

  const onMapReady = () => {
    const map = mapRef.current;
    if (!map || !region || settled.current) return;
    map
      .takeSnapshot({ width, height, region, format: 'png', quality: 1, result: 'file' })
      .then((file) => {
        if (alive.current && !settled.current) setUri(file);
      })
      .catch(() => settle('failed'));
  };

  const [top, mid, low] = scene;
  const MapView = maps?.default;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="share-map">
      {MapView && region && status === 'loading' ? (
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          onMapReady={onMapReady}
          scrollEnabled={false}
          zoomEnabled={false}
          zoomTapEnabled={false}
          rotateEnabled={false}
          pitchEnabled={false}
          showsUserLocation={false}
          showsPointsOfInterests={false}
          showsCompass={false}
          showsScale={false}
          toolbarEnabled={false}
          userInterfaceStyle="dark"
          testID="share-map-view"
        />
      ) : null}
      {uri && status !== 'failed' ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} onLoad={() => settle('ready')} onError={() => settle('failed')} testID="share-map-image" />
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(mid, 0.3) }]} />
      <LinearGradient
        colors={[top, top, withAlpha(top, 0)]}
        locations={[0, band.top / (band.top + band.fade), 1]}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: band.top + band.fade }}
      />
      <LinearGradient
        colors={[withAlpha(low, 0), low, low]}
        locations={[0, band.fade / (band.bottom + band.fade), 1]}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: band.bottom + band.fade }}
      />
      {status === 'ready' && path ? <RouteLine d={path} width={width} height={height} stroke={stroke} strokeWidth={strokeWidth} /> : null}
    </View>
  );
}

function RouteLine({ d, width, height, stroke, strokeWidth }: { d: string; width: number; height: number; stroke: string; strokeWidth: number }) {
  const start = d.match(/^M(-?[\d.]+) (-?[\d.]+)/);
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} testID="share-map-route">
      <Path d={d} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {start ? <Circle cx={Number(start[1])} cy={Number(start[2])} r={strokeWidth} fill={stroke} /> : null}
    </Svg>
  );
}
