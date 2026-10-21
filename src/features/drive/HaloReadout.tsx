import { useEffect, useState, type ReactNode } from 'react';
import { View, type TextStyle } from 'react-native';
import type { AnimatedStyle } from 'react-native-reanimated';

import { MPS_PER_MPH } from '@/core/detectors/common';
import { CARRY_MAX_MS, carriedSpeed, SPEED_TICK_MS, wholeSpeed } from '@/core/engine/displaySpeed';
import { useShownSpeed, type ShownSpeed } from '@/drive/useDrive';
import { KMH_PER_MPH } from '@/lib/units';
import { speedDigits, SpeedReadout, unitLineHeight, unitTop } from '@/ui/drive';

import { HALO_POINTS_GAP_PT } from './hudLayout';
import { unitLabel, type HudUnits } from './useHudUnits';

const wallClock = (): number => Date.now();

/**
 * The whole number to show now, in the driver's units (null with no drive): the estimate carried on
 * from the time it stands for along its acceleration (`carriedSpeed`), re-read every
 * `SPEED_TICK_MS` until `CARRY_MAX_MS` after that time, and rounded with a little hysteresis
 * (`wholeSpeed`) so a speed sitting at x.5 doesn't flicker. A cruising car, 0 and a held speed
 * never tick.
 */
export function useCarriedSpeed(shown: ShownSpeed, units: HudUnits): number | null {
  const { mps, accel, at } = shown;
  const [, setTick] = useState(0);
  const carrying = mps !== null && mps > 0 && accel !== 0 && at !== null;
  useEffect(() => {
    if (!carrying || at === null) return;
    const end = at + CARRY_MAX_MS;
    if (wallClock() >= end) return;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      if (wallClock() >= end) clearInterval(id);
    }, SPEED_TICK_MS);
    return () => clearInterval(id);
  }, [carrying, at, mps, accel]);
  const now = mps === null ? null : at === null ? mps : carriedSpeed(mps, accel, wallClock() - at);
  const value = now === null ? null : (now / MPS_PER_MPH) * (units === 'km' ? KMH_PER_MPH : 1);
  // The number shown last, kept across renders (React's state-from-props pattern; `wholeSpeed` of
  // its own answer is that answer, so this settles at once).
  const [whole, setWhole] = useState<{ n: number | null; units: HudUnits }>({ n: null, units });
  const prev = whole.units === units ? whole.n : null;
  const next = value === null ? null : wholeSpeed(prev, value);
  if (next !== whole.n || units !== whole.units) setWhole({ n: next, units });
  return next;
}

export type HaloReadoutProps = {
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
 * The speed inside the halo, carried on between fixes (`useCarriedSpeed`): its own component reading
 * its own slice of the drive, so each fix and each tick re-render the numerals and nothing else. In
 * landscape the stack is raised by `lift` and the points sit under the unit label, inside the ring,
 * whether or not they show (nothing moves).
 */
export function HaloReadout({ units, pt2, pt3, unitPt, haloPoints, points, ...rest }: HaloReadoutProps) {
  const speed = useCarriedSpeed(useShownSpeed(), units);
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
