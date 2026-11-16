/**
 * The teardrop map pin the drive summary's route map and the All trips map's spots share: a round
 * head tapering to a point, Google Maps style, with a glyph (an event's icon, a place's) in the
 * head; the round start marker the route map puts where a drive began; where a custom marker view
 * sits so its tip lands on the coordinate on both map engines; and the short window in which a
 * newly drawn marker keeps repainting before it is frozen.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * The pin's fixed 32 × 44 point view. The tip is 42 points down (the 2 below it hold the drop
 * shadow); the head is a 28-point circle centred 15 points down.
 */
export const PIN = { width: 32, height: 44, tipX: 16, tipY: 42, headY: 15, headR: 14 } as const;
export const PIN_PATH = 'M16 42 C13.2 35 2 26.5 2 15 A14 14 0 1 1 30 15 C30 26.5 18.8 35 16 42 Z';

/**
 * Where a custom marker view `width` × `height` sits so its point (`tipX`, `tipY`) lands on the
 * coordinate, for both map engines: Google Maps reads `anchor` (a fraction of the view), Apple Maps
 * centres the view on the coordinate and reads `centerOffset` (points; negative moves it up and
 * left). Each engine ignores the other's prop, so a marker passes both.
 */
export function pinAnchor(width: number, height: number, tipX: number, tipY: number): { anchor: { x: number; y: number }; centerOffset: { x: number; y: number } } {
  return { anchor: { x: tipX / width, y: tipY / height }, centerOffset: { x: width / 2 - tipX, y: height / 2 - tipY } };
}

/** A lone pin's placement: its tip on the coordinate. */
export const PIN_PLACE = pinAnchor(PIN.width, PIN.height, PIN.tipX, PIN.tipY);

/** How long a newly drawn custom marker keeps redrawing before it is frozen (Android snapshots). */
export const SETTLE_MS = 800;

/**
 * True while custom markers drawn for `key` may still be painting: they redraw for a moment, then
 * freeze, so Android's marker snapshot holds the finished pin and the map stays cheap afterwards.
 */
export function useSettling(key: string): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return settled !== key;
}

/** The soft shadow every marker casts: black at 0.22, 1.5 points down. */
const SHADOW = { fill: '#000000', fillOpacity: 0.22, dy: 1.5 } as const;

/** The teardrop in `fill` with an `edge` outline and a soft shadow, its glyph (16 pt: an event's icon, a place's) centred in the head. */
export function TeardropPin({ fill, edge, children, testID }: { fill: string; edge: string; children: ReactNode; testID?: string }) {
  return (
    <View collapsable={false} testID={testID} style={{ width: PIN.width, height: PIN.height }}>
      <Svg width={PIN.width} height={PIN.height} viewBox={`0 0 ${PIN.width} ${PIN.height}`} style={StyleSheet.absoluteFill}>
        <Path d={PIN_PATH} fill={SHADOW.fill} fillOpacity={SHADOW.fillOpacity} transform={`translate(0 ${SHADOW.dy})`} />
        <Path d={PIN_PATH} fill={fill} stroke={edge} strokeWidth={1.5} strokeLinejoin="round" />
      </Svg>
      <View
        style={{
          position: 'absolute',
          left: PIN.tipX - PIN.headR,
          top: PIN.headY - PIN.headR,
          width: PIN.headR * 2,
          height: PIN.headR * 2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </View>
  );
}

/**
 * The round start marker, Google Maps' origin circle: a white disc with a soft shadow, a 3-point
 * `ring` inset 1.5 points from its edge (the white rim is its outline on dark tiles) and a white
 * face inside it. `START.plain` (20 pt) is the bare circle; `START.place` (30 pt, about the size of
 * a pin's head) holds a saved place's 16 pt icon in the face. The view is the disc plus 2 points
 * all round for the shadow, so the disc's centre is the view's: it sits centred on its point.
 */
export const START = { plain: 20, place: 30, ring: 3, rim: 1.5, pad: 2 } as const;

export function StartDisc({ ring, face, size, children, testID }: { ring: string; face: string; size: number; children?: ReactNode; testID?: string }) {
  const view = size + 2 * START.pad;
  const c = view / 2;
  return (
    <View collapsable={false} testID={testID} style={{ width: view, height: view, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={view} height={view} viewBox={`0 0 ${view} ${view}`} style={StyleSheet.absoluteFill}>
        <Circle cx={c} cy={c + SHADOW.dy} r={size / 2} fill={SHADOW.fill} fillOpacity={SHADOW.fillOpacity} />
        <Circle cx={c} cy={c} r={size / 2} fill={face} />
        <Circle cx={c} cy={c} r={size / 2 - START.rim - START.ring / 2} fill={face} stroke={ring} strokeWidth={START.ring} />
      </Svg>
      {children}
    </View>
  );
}
