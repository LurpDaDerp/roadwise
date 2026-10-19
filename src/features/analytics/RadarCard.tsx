import { useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Polygon } from 'react-native-svg';

import { Card, Text, tokens, useFontScale, useTheme, withAlpha } from '@/ui';

import { analyticsCopy } from './copy';
import { AXES, type AxisScores } from './model';
import { sizeAt } from './textSize';

/** Grid rings, as a share of the full score. */
export const RADAR_RINGS = [0.25, 0.5, 0.75, 1] as const;
/** The hexagon's radius stays within these, so it reads on a small phone and stays near its labels on a big one. */
export const RADAR_R_MIN = 56;
export const RADAR_R_MAX = 110;
/** The axis labels follow Dynamic Type up to this multiple; past it they would crowd the chart. */
export const RADAR_LABEL_MAX_SCALE = 1.3;
/** Between a vertex and its label. */
const LABEL_GAP = 6;
/** A side label's width ("Acceleration" at 12 pt; longer names shrink to fit). */
const SIDE_LABEL_W = 72;
/** The top and bottom labels' width, centred on their vertex. */
const END_LABEL_W = 120;

export interface Pt {
  x: number;
  y: number;
}

/** Vertex `i` of `n`, clockwise from the top, at `r` from the centre. */
export function radarPoint(i: number, n: number, r: number, c: Pt): Pt {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

/** The score polygon's points ("x,y x,y …"); a missing score sits at the centre. */
export function radarPolygon(scores: readonly (number | null)[], r: number, c: Pt): string {
  return scores
    .map((s, i) => {
      const p = radarPoint(i, scores.length, (Math.max(0, Math.min(100, s ?? 0)) / 100) * r, c);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');
}

export interface RadarLabelBox {
  left: number;
  top: number;
  width: number;
  height: number;
  align: 'left' | 'center' | 'right';
}

export interface RadarGeometry {
  width: number;
  height: number;
  r: number;
  c: Pt;
  /** One box per axis, in `AXES` order, each wholly outside the hexagon. */
  labels: RadarLabelBox[];
}

/**
 * The chart's box for a given width and label text scale. Each axis's name-over-score label sits
 * outside its vertex: above the top one, below the bottom one, and beside the four side ones
 * (left-aligned on the right, right-aligned on the left), so no label crosses a ring or the shape.
 * The radius is what the side labels leave of the width; the height is what the top and bottom
 * labels need.
 */
export function radarGeometry(width: number, labelScale: number, n: number = AXES.length): RadarGeometry {
  const { caption, subhead } = tokens.type;
  const labelH = (caption.lineHeight + subhead.lineHeight) * labelScale;
  const half = width / 2;
  // The side vertices sit cos 30° × r out from the centre.
  const reach = Math.cos(Math.PI / 6);
  const r = Math.max(RADAR_R_MIN, Math.min(RADAR_R_MAX, (half - LABEL_GAP - SIDE_LABEL_W) / reach));
  const height = Math.ceil(2 * (r + LABEL_GAP + labelH));
  const c = { x: half, y: height / 2 };
  const sideW = Math.min(SIDE_LABEL_W, half - LABEL_GAP - reach * r);
  const labels = Array.from({ length: n }, (_, i): RadarLabelBox => {
    const p = radarPoint(i, n, r, c);
    if (Math.abs(p.x - c.x) < 1) {
      const above = p.y < c.y;
      return { left: p.x - END_LABEL_W / 2, top: above ? p.y - LABEL_GAP - labelH : p.y + LABEL_GAP, width: END_LABEL_W, height: labelH, align: 'center' };
    }
    const right = p.x > c.x;
    return {
      left: right ? p.x + LABEL_GAP : p.x - LABEL_GAP - sideW,
      top: p.y - labelH / 2,
      width: sideW,
      height: labelH,
      align: right ? 'left' : 'right',
    };
  });
  return { width, height, r, c, labels };
}

const shown = (s: number | null): string => (s === null ? '—' : String(s));

/** The whole radar for a screen reader: the rating, then every axis. */
export function radarLabel(rating: number | null, scores: AxisScores): string {
  const axes = AXES.map((a) => `${a.label} ${scores[a.key] === null ? 'no data' : scores[a.key]}`).join(', ');
  const head = rating === null ? `${analyticsCopy.radar.rating}, ${analyticsCopy.radar.noScore}` : `${analyticsCopy.radar.rating} ${rating}`;
  return `${head}. ${axes}.`;
}

/**
 * The six-axis radar of the last 30 days: grid rings at 25/50/75/100, a spoke per axis, one
 * filled polygon, and the Safety Rating in the middle. All of it in the page ink (no colour
 * coding), with each axis's name and score around the outside.
 */
export function RadarCard({ rating, scores }: { rating: number | null; scores: AxisScores }) {
  const t = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const labelScale = useFontScale(RADAR_LABEL_MAX_SCALE);
  // The screen gutter and the card's padding on both sides.
  const { width, height, r, c, labels } = radarGeometry(Math.max(240, windowWidth - 4 * t.space.lg), labelScale);
  const n = AXES.length;
  const values = AXES.map((a) => scores[a.key]);
  const ring = (k: number) =>
    Array.from({ length: n }, (_, i) => radarPoint(i, n, r * k, c))
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
  const shownRating = rating === null ? '—' : String(Math.round(rating));

  return (
    <Card testID="analytics-radar">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={radarLabel(rating === null ? null : Math.round(rating), scores)}
        style={{ width, height, alignSelf: 'center' }}
      >
        <Svg width={width} height={height}>
          {RADAR_RINGS.map((k) => (
            <Polygon key={k} points={ring(k)} fill="none" stroke={t.colors.divider} strokeWidth={k === 1 ? 1.5 : 1} />
          ))}
          {AXES.map((a, i) => {
            const p = radarPoint(i, n, r, c);
            return <Line key={a.key} x1={c.x} y1={c.y} x2={p.x} y2={p.y} stroke={t.colors.divider} strokeWidth={1} />;
          })}
          <Polygon
            testID="radar-shape"
            points={radarPolygon(values, r, c)}
            fill={withAlpha(t.colors.text, 0.12)}
            stroke={t.colors.text}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {values.map((s, i) => {
            const p = radarPoint(i, n, (Math.max(0, Math.min(100, s ?? 0)) / 100) * r, c);
            return <Circle key={AXES[i]!.key} cx={p.x} cy={p.y} r={3} fill={t.colors.text} />;
          })}
        </Svg>
        {AXES.map((a, i) => {
          const box = labels[i]!;
          const items = box.align === 'left' ? 'flex-start' : box.align === 'right' ? 'flex-end' : 'center';
          return (
            <View
              key={a.key}
              testID={`radar-axis-${a.key}`}
              style={{ position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height, alignItems: items, justifyContent: 'center' }}
            >
              <Text variant="caption" tone="muted" numberOfLines={1} adjustsFontSizeToFit style={[sizeAt('caption', labelScale), { textAlign: box.align }]}>
                {a.label}
              </Text>
              <Text variant="subhead" numberOfLines={1} adjustsFontSizeToFit style={[sizeAt('subhead', labelScale), { fontWeight: '700', textAlign: box.align }]}>
                {shown(scores[a.key])}
              </Text>
            </View>
          );
        })}
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="display" testID="radar-rating">
            {shownRating}
          </Text>
          <Text variant="caption" tone="muted">
            {analyticsCopy.radar.rating}
          </Text>
        </View>
      </View>
      <Text variant="footnote" tone="subtle" style={{ textAlign: 'center' }}>
        {analyticsCopy.radar.window}
      </Text>
    </Card>
  );
}
