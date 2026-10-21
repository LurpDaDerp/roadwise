/**
 * The teardrop map pin the drive summary's route map and the All trips map's spots share: a round
 * head tapering to a point, Google Maps style, with an event's icon in the head; where a custom
 * marker view sits so its tip lands on the coordinate on both map engines; and the short window in
 * which a newly drawn marker keeps repainting before it is frozen.
 */
import type { EventType } from '@scoring';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { EventIcon } from './EventIcon';

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

/** The teardrop in `fill` with an `edge` outline and a soft shadow, the event's icon in its head. */
export function TeardropPin({ fill, edge, type, iconColor }: { fill: string; edge: string; type: EventType; iconColor: string }) {
  return (
    <View collapsable={false} style={{ width: PIN.width, height: PIN.height }}>
      <Svg width={PIN.width} height={PIN.height} viewBox={`0 0 ${PIN.width} ${PIN.height}`} style={StyleSheet.absoluteFill}>
        <Path d={PIN_PATH} fill="#000000" fillOpacity={0.22} transform="translate(0 1.5)" />
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
        <EventIcon type={type} size={16} color={iconColor} />
      </View>
    </View>
  );
}
