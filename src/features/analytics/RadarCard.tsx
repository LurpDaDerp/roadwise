import { type GestureResponderEvent, Pressable, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Polygon } from 'react-native-svg';

import { Card, Text, tokens, useFontScale, useTheme, withAlpha } from '@/ui';

import { analyticsCopy } from './copy';
import { AXES, type AxisKey, type AxisScores } from './model';
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
/** The widest a side label's chip may be ("Phone use" at 12 pt; a longer name shrinks to fit). */
const SIDE_LABEL_W = 84;
/** The top and bottom labels' width, centred on their vertex. */
const END_LABEL_W = 132;
/** A chip's padding around its name. */
export const CHIP_PAD_X = 10;
export const CHIP_PAD_Y = 6;

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

/**
 * The axis a tap on the chart at (x, y) is nearest to by angle, or null in the middle (the rating)
 * and well outside the outer ring. A tap anywhere on a category's spoke opens it, as its label does.
 */
export function axisAt(x: number, y: number, r: number, c: Pt, n: number = AXES.length): number | null {
  const dx = x - c.x;
  const dy = y - c.y;
  const d = Math.hypot(dx, dy);
  if (!(d >= r * 0.3) || d > r + 2 * LABEL_GAP) return null;
  const step = (2 * Math.PI) / n;
  const i = Math.round((Math.atan2(dy, dx) + Math.PI / 2) / step);
  return ((i % n) + n) % n;
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
  /** The name chip's height (its text and padding). */
  chip: number;
  /** One touch box per axis, in `AXES` order, each wholly outside the hexagon and at least 44 pt tall (a button). */
  labels: RadarLabelBox[];
}

/**
 * The chart's box for a given width and label text scale. Each axis's name sits on a chip outside
 * its vertex: above the top one, below the bottom one, and beside the four side ones (starting at
 * the vertex on the right, ending at it on the left), so no label crosses a ring or the shape. The
 * radius is what the side labels leave of the width; the height is what the top and bottom labels
 * need. Each chip's touch box is at least the 44 pt touch floor, growing evenly above and below it.
 */
export function radarGeometry(width: number, labelScale: number, n: number = AXES.length): RadarGeometry {
  const chip = Math.ceil(tokens.type.caption.lineHeight * labelScale + 2 * CHIP_PAD_Y);
  const pad = Math.max(0, (tokens.size.touch - chip) / 2);
  const labelH = chip + 2 * pad;
  const half = width / 2;
  // The side vertices sit cos 30° × r out from the centre.
  const reach = Math.cos(Math.PI / 6);
  const r = Math.max(RADAR_R_MIN, Math.min(RADAR_R_MAX, (half - LABEL_GAP - SIDE_LABEL_W) / reach));
  const height = Math.ceil(2 * (r + LABEL_GAP + chip + pad));
  const c = { x: half, y: height / 2 };
  const sideW = Math.min(SIDE_LABEL_W, half - LABEL_GAP - reach * r);
  const labels = Array.from({ length: n }, (_, i): RadarLabelBox => {
    const p = radarPoint(i, n, r, c);
    if (Math.abs(p.x - c.x) < 1) {
      const above = p.y < c.y;
      // The chip keeps its gap from the vertex; the touch padding may reach past it.
      const top = above ? p.y - LABEL_GAP - chip - pad : p.y + LABEL_GAP - pad;
      return {
        left: p.x - END_LABEL_W / 2,
        top,
        width: END_LABEL_W,
        height: labelH,
        align: 'center',
      };
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
  return { width, height, r, c, chip, labels };
}

/** The whole radar for a screen reader: the rating, then every axis. */
export function radarLabel(rating: number | null, scores: AxisScores): string {
  const axes = AXES.map((a) => `${a.label} ${scores[a.key] === null ? 'no data' : scores[a.key]}`).join(', ');
  const head =
    rating === null
      ? `${analyticsCopy.radar.rating}, ${analyticsCopy.radar.noScore}`
      : `${analyticsCopy.radar.rating} ${rating} out of 100`;
  return `${head}. ${axes}.`;
}

/**
 * The six-axis radar of the last 30 days: grid rings at 25/50/75/100, a spoke per axis, one
 * filled polygon, and the Safety Rating in the middle. All of it in the page ink (no colour
 * coding), with each axis's name around the outside on a faint chip: a button that opens that
 * category's details, whether or not it has a score yet. A tap on the chart itself opens the
 * category whose spoke it is nearest.
 */
export function RadarCard({ rating, scores, onOpen }: { rating: number | null; scores: AxisScores; onOpen: (axis: AxisKey) => void }) {
  const t = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const labelScale = useFontScale(RADAR_LABEL_MAX_SCALE);
  // The screen gutter and the card's padding on both sides.
  const { width, height, r, c, chip, labels } = radarGeometry(Math.max(240, windowWidth - 4 * t.space.lg), labelScale);
  const n = AXES.length;
  const values = AXES.map((a) => scores[a.key]);
  const ring = (k: number) =>
    Array.from({ length: n }, (_, i) => radarPoint(i, n, r * k, c))
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
  const shownRating = rating === null ? '—' : String(Math.round(rating));
  const halo = {
    textShadowColor: t.colors.surface,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  };
  // Everything drawn inside the chart ignores touches, so a tap's location is in the chart's own frame.
  const tapChart = (e: GestureResponderEvent) => {
    const i = axisAt(e.nativeEvent.locationX, e.nativeEvent.locationY, r, c);
    if (i !== null) onOpen(AXES[i]!.key);
  };

  return (
    <Card testID="analytics-radar">
      <View style={{ width, height, alignSelf: 'center' }}>
        <Pressable
          accessible
          accessibilityRole="image"
          accessibilityLabel={radarLabel(rating === null ? null : Math.round(rating), scores)}
          onPress={tapChart}
          testID="radar-chart"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0 }}>
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
              {/* No dot for an axis with no score: it would only pile up under the centre number. */}
              {values.map((s, i) => {
                if (s === null) return null;
                const p = radarPoint(i, n, (Math.max(0, Math.min(100, s)) / 100) * r, c);
                return <Circle key={AXES[i]!.key} cx={p.x} cy={p.y} r={3} fill={t.colors.text} testID={`radar-dot-${AXES[i]!.key}`} />;
              })}
            </Svg>
          </View>
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* A halo in the card's colour keeps the shape's lines from running through the glyphs. */}
            <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <Text variant="display" testID="radar-rating" style={halo}>
                {shownRating}
              </Text>
              {rating === null ? null : (
                <Text variant="footnote" tone="muted" testID="radar-out-of" style={halo}>
                  {analyticsCopy.radar.outOf}
                </Text>
              )}
            </View>
            <Text variant="caption" tone="muted" style={halo}>
              {analyticsCopy.radar.rating}
            </Text>
          </View>
        </Pressable>
        {AXES.map((a, i) => {
          const box = labels[i]!;
          const items = box.align === 'left' ? 'flex-start' : box.align === 'right' ? 'flex-end' : 'center';
          return (
            <Pressable
              key={a.key}
              testID={`radar-axis-${a.key}`}
              accessibilityRole="button"
              accessibilityLabel={analyticsCopy.radar.axis(a.label, scores[a.key])}
              accessibilityHint={analyticsCopy.radar.axisHint}
              onPress={() => onOpen(a.key)}
              style={{
                position: 'absolute',
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                alignItems: items,
                justifyContent: 'center',
              }}
            >
              {({ pressed }) => (
                <View
                  testID={`radar-chip-${a.key}`}
                  style={{
                    height: chip,
                    maxWidth: box.width,
                    paddingHorizontal: CHIP_PAD_X,
                    borderRadius: chip / 2,
                    justifyContent: 'center',
                    backgroundColor: withAlpha(t.colors.text, pressed ? 0.14 : 0.07),
                  }}
                >
                  <Text
                    variant="caption"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.7}
                    style={[sizeAt('caption', labelScale), { fontWeight: '600', textAlign: 'center' }]}
                  >
                    {a.label}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
      <Text variant="footnote" tone="subtle" style={{ textAlign: 'center' }}>
        {analyticsCopy.radar.window}
      </Text>
    </Card>
  );
}
