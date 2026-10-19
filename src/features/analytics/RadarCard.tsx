import { useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Polygon } from 'react-native-svg';

import { Card, Text, useTheme, withAlpha } from '@/ui';

import { analyticsCopy } from './copy';
import { AXES, type AxisScores } from './model';

/** Grid rings, as a share of the full score. */
export const RADAR_RINGS = [0.25, 0.5, 0.75, 1] as const;
/** The chart never grows past this, so the labels stay near it on a tablet. */
export const RADAR_MAX = 320;
/** Room kept outside the hexagon for each axis's name and score. */
const LABEL_ROOM = 42;
const LABEL_W = 84;

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
  const { width } = useWindowDimensions();
  // The screen gutter and the card's padding on both sides.
  const size = Math.max(200, Math.min(RADAR_MAX, width - 4 * t.space.lg));
  const c = { x: size / 2, y: size / 2 };
  const r = size / 2 - LABEL_ROOM;
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
        style={{ width: size, height: size, alignSelf: 'center' }}
      >
        <Svg width={size} height={size}>
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
          const along = Math.abs(Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / n));
          const p = radarPoint(i, n, r + 14 + 8 * along, c);
          return (
            <View
              key={a.key}
              testID={`radar-axis-${a.key}`}
              style={{ position: 'absolute', width: LABEL_W, left: p.x - LABEL_W / 2, top: p.y - 18, alignItems: 'center' }}
            >
              <Text variant="caption" tone="muted" numberOfLines={1} adjustsFontSizeToFit>
                {a.label}
              </Text>
              <Text variant="subhead" style={{ fontWeight: '700' }} numberOfLines={1}>
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
