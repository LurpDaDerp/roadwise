import { useEffect, useState, type ReactNode } from 'react';
import { View, type TextStyle } from 'react-native';
import type { AnimatedStyle } from 'react-native-reanimated';

import { MPS_PER_MPH } from '@/core/detectors/common';
import { CARRY_MAX_MS, carriedSpeed, SPEED_TICK_MS } from '@/core/engine/displaySpeed';
import { speedDigits, SpeedReadout, unitLineHeight, unitTop } from '@/ui/drive';

import { HALO_POINTS_GAP_PT } from './hudLayout';
import { inUnits, unitLabel, type HudUnits } from './useHudUnits';

/**
 * The speed to show now (mph): the row's speed carried on along its acceleration (mph/s) since the
 * row landed, re-read every `SPEED_TICK_MS` for up to `CARRY_MAX_MS`, then still until the next row
 * (`rowTs`). A cruising car, 0 and a held speed never tick.
 */
export function useCarriedSpeed(speedMph: number | null, accelMph: number, rowTs: number | null): number | null {
  const [elapsed, setElapsed] = useState(0);
  const [row, setRow] = useState(rowTs);
  // A new row starts from its own speed in the same render (React's state-from-props pattern).
  if (row !== rowTs) {
    setRow(rowTs);
    setElapsed(0);
  }
  const carrying = speedMph !== null && speedMph > 0 && accelMph !== 0;
  useEffect(() => {
    if (!carrying) return;
    const start = Date.now();
    const id = setInterval(() => {
      const e = Math.min(Date.now() - start, CARRY_MAX_MS);
      setElapsed(e);
      if (e >= CARRY_MAX_MS) clearInterval(id);
    }, SPEED_TICK_MS);
    return () => clearInterval(id);
  }, [carrying, rowTs]);
  if (speedMph === null || !carrying) return speedMph;
  return carriedSpeed(speedMph * MPS_PER_MPH, accelMph * MPS_PER_MPH, elapsed) / MPS_PER_MPH;
}

export type HaloReadoutProps = {
  speedMph: number | null;
  accelMph: number;
  rowTs: number | null;
  units: HudUnits;
  pt2: number;
  pt3: number;
  unitPt: number;
  color: string;
  unitColor: string;
  numeralStyle?: AnimatedStyle<TextStyle>;
  speeding?: boolean;
  /** Landscape: the points inside the halo under the unit label (`hudLayout` `haloPoints`). */
  haloPoints: { lift: number; w: number } | null;
  /** The points while stopped, else null (it fades itself in and out). */
  points: ReactNode;
};

/**
 * The speed inside the halo, carried on between rows (`useCarriedSpeed`): its own component, so the
 * ticks re-render the numerals and nothing else. In landscape the stack is raised by `lift` and the
 * points sit under the unit label, inside the ring, whether or not they show (nothing moves).
 */
export function HaloReadout({ speedMph, accelMph, rowTs, units, pt2, pt3, unitPt, haloPoints, points, ...rest }: HaloReadoutProps) {
  const speed = inUnits(useCarriedSpeed(speedMph, accelMph, rowTs), units);
  const size = speedDigits(speed) >= 3 ? pt3 : pt2;
  const readout = <SpeedReadout speed={speed} unit={unitLabel(units)} size={size} {...rest} />;
  if (haloPoints === null) return readout;
  return (
    <View testID="hud-halo-stack" style={{ transform: [{ translateY: -haloPoints.lift }] }}>
      {readout}
      <View
        testID="hud-halo-points"
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: unitTop(size) + unitLineHeight(unitPt) + HALO_POINTS_GAP_PT,
          left: '50%',
          width: haloPoints.w,
          marginLeft: -haloPoints.w / 2,
          alignItems: 'center',
        }}
      >
        {points}
      </View>
    </View>
  );
}
