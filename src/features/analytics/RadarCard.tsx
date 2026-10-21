import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { type GestureResponderEvent, Pressable, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Polygon } from 'react-native-svg';

import { Card, Sheet, Text, tokens, useFontScale, useTheme, withAlpha } from '@/ui';

import { analyticsCopy } from './copy';
import { AXES, DASHPAL_AXIS, type AxisKey, type AxisScores } from './model';
import { sizeAt } from './textSize';

const HOW = analyticsCopy.radar.how;

/** Grid rings, as a share of the full score: 0, 25, 50, 75 and 100. */
export const RADAR_RINGS = [0, 0.25, 0.5, 0.75, 1] as const;
/**
 * Where a score of 0 sits, as a share of the radius: the zero ring is a hexagon of its own around
 * the centre number, so a shape with low scores (or none yet) is never a point.
 */
export const RADAR_ZERO = 0.3;
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

/** A score's distance from the centre: 0 on the zero ring (`RADAR_ZERO` × r), 100 on the outer one; clamped to 0–100, a missing score as 0. */
export function radiusFor(score: number | null, r: number): number {
  const s = score === null || !Number.isFinite(score) ? 0 : Math.max(0, Math.min(100, score));
  return r * (RADAR_ZERO + ((1 - RADAR_ZERO) * s) / 100);
}

/**
 * The score polygon's points ("x,y x,y …"); a missing score sits on the zero ring, and a locked
 * axis (`skip`) is left out, its neighbours joined across it.
 */
export function radarPolygon(scores: readonly (number | null)[], r: number, c: Pt, skip: readonly number[] = []): string {
  return scores
    .flatMap((s, i) => {
      if (skip.includes(i)) return [];
      const p = radarPoint(i, scores.length, radiusFor(s, r), c);
      return [`${p.x.toFixed(1)},${p.y.toFixed(1)}`];
    })
    .join(' ');
}

/**
 * The axis a tap on the chart at (x, y) is nearest to by angle, or null inside the zero ring (the
 * rating) and well outside the outer ring. A tap anywhere on a category's spoke opens it, as its
 * label does.
 */
export function axisAt(x: number, y: number, r: number, c: Pt, n: number = AXES.length): number | null {
  const dx = x - c.x;
  const dy = y - c.y;
  const d = Math.hypot(dx, dy);
  if (!(d >= r * RADAR_ZERO) || d > r + 2 * LABEL_GAP) return null;
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

/** The whole radar for a screen reader: the rating, then every axis (a locked one says it needs DashPal). */
export function radarLabel(rating: number | null, scores: AxisScores, locked: readonly AxisKey[] = []): string {
  const axes = AXES.map((a) => `${a.label} ${locked.includes(a.key) ? 'needs DashPal' : scores[a.key] === null ? 'no data' : scores[a.key]}`).join(', ');
  const head =
    rating === null
      ? `${analyticsCopy.radar.rating}, ${analyticsCopy.radar.noScore}`
      : `${analyticsCopy.radar.rating} ${rating} out of 100`;
  return `${head}. ${axes}.`;
}

/**
 * The six-axis radar of the last 30 days: grid rings at 0/25/50/75/100 (0 is a small hexagon of
 * its own around the centre, where a score of 0, or none yet, sits), a spoke per axis, one filled
 * polygon, and the Safety Rating in the middle. All of it in the page ink (no colour coding), with
 * each axis's name around the outside on a faint chip: a button that opens that category's
 * details, whether or not it has a score yet. A tap on the chart itself opens the category whose
 * spoke it is nearest. Without a paired DashPal, Attention is locked: its chip is greyed with a
 * lock, its spoke faint, it has no point on the shape, and its sheet says how to get it. Under the
 * chart, "Last 30 days" and a "How it works" button that opens a sheet saying what makes the total.
 */
export function RadarCard({
  rating,
  scores,
  dashpalPaired,
  onOpen,
}: {
  rating: number | null;
  scores: AxisScores;
  dashpalPaired: boolean;
  onOpen: (axis: AxisKey) => void;
}) {
  const t = useTheme();
  const [how, setHow] = useState(false);
  const { width: windowWidth } = useWindowDimensions();
  const labelScale = useFontScale(RADAR_LABEL_MAX_SCALE);
  // The screen gutter and the card's padding on both sides.
  const { width, height, r, c, chip, labels } = radarGeometry(Math.max(240, windowWidth - 4 * t.space.lg), labelScale);
  const n = AXES.length;
  const locked: AxisKey[] = dashpalPaired ? [] : [DASHPAL_AXIS];
  const isLocked = (key: AxisKey) => locked.includes(key);
  const values = AXES.map((a) => (isLocked(a.key) ? null : scores[a.key]));
  const skip = AXES.flatMap((a, i) => (isLocked(a.key) ? [i] : []));
  const ring = (k: number) =>
    Array.from({ length: n }, (_, i) => radarPoint(i, n, radiusFor(k * 100, r), c))
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
          accessibilityLabel={radarLabel(rating === null ? null : Math.round(rating), scores, locked)}
          onPress={tapChart}
          testID="radar-chart"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0 }}>
            <Svg width={width} height={height}>
              {RADAR_RINGS.map((k) => (
                <Polygon key={k} points={ring(k)} fill="none" stroke={t.colors.divider} strokeWidth={k === 1 ? 1.5 : 1} testID={`radar-ring-${k * 100}`} />
              ))}
              {AXES.map((a, i) => {
                const p = radarPoint(i, n, r, c);
                return (
                  <Line
                    key={a.key}
                    x1={c.x}
                    y1={c.y}
                    x2={p.x}
                    y2={p.y}
                    stroke={t.colors.divider}
                    strokeWidth={1}
                    strokeDasharray={isLocked(a.key) ? '3 4' : undefined}
                  />
                );
              })}
              <Polygon
                testID="radar-shape"
                points={radarPolygon(values, r, c, skip)}
                fill={withAlpha(t.colors.text, 0.12)}
                stroke={t.colors.text}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {/* No dot for an axis with no score: the shape meets the zero ring there, unmarked. */}
              {values.map((s, i) => {
                if (s === null) return null;
                const p = radarPoint(i, n, radiusFor(s, r), c);
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
          const lock = isLocked(a.key);
          return (
            <Pressable
              key={a.key}
              testID={`radar-axis-${a.key}`}
              accessibilityRole="button"
              accessibilityLabel={lock ? analyticsCopy.radar.locked(a.label) : analyticsCopy.radar.axis(a.label, scores[a.key])}
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
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    backgroundColor: withAlpha(t.colors.text, pressed ? 0.14 : lock ? 0.04 : 0.07),
                  }}
                >
                  {lock ? <Ionicons name="lock-closed" size={Math.round(sizeAt('caption', labelScale).fontSize)} color={t.colors.textMuted} testID={`radar-lock-${a.key}`} /> : null}
                  <Text
                    variant="caption"
                    tone={lock ? 'muted' : undefined}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.7}
                    style={[sizeAt('caption', labelScale), { fontWeight: '600', textAlign: 'center', flexShrink: 1 }]}
                  >
                    {a.label}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }} testID="radar-footer">
        <Text variant="footnote" tone="subtle" style={{ flex: 1 }}>
          {analyticsCopy.radar.window}
        </Text>
        <Pressable
          testID="radar-how"
          accessibilityRole="button"
          accessibilityLabel={HOW.label}
          accessibilityHint={HOW.hint}
          onPress={() => setHow(true)}
          style={{ minHeight: t.size.touch, minWidth: t.size.touch, justifyContent: 'center' }}
        >
          {({ pressed }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                minHeight: chip,
                paddingHorizontal: CHIP_PAD_X,
                borderRadius: chip / 2,
                backgroundColor: withAlpha(t.colors.text, pressed ? 0.14 : 0.07),
              }}
            >
              <Ionicons name="information-circle-outline" size={t.size.iconSm} color={t.colors.text} />
              <Text variant="footnote" style={{ fontWeight: '600' }}>
                {HOW.label}
              </Text>
            </View>
          )}
        </Pressable>
      </View>
      <Sheet visible={how} onClose={() => setHow(false)} title={HOW.title} testID="radar-how-sheet">
        <Text variant="body" testID="radar-how-body">
          {HOW.body}
        </Text>
      </Sheet>
    </Card>
  );
}
