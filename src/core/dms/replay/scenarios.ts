// The replay scenarios (plan Task 12, rev0 table, plus C-26's falling asleep into LOST): 18 drives, each a seeded driver model. The tests hold
// the expectations; this file holds the drives and the times the expectations refer to. Test tooling.
//
// Every drive starts with a lead-in of attentive straight driving at 60 km/h (LEAD_S): calibration passes
// at about 60 s and the warm-up (60 s at ≥ 20 km/h) is over, so the event at EVENT_S meets a calibrated
// engine. Blinks are natural (200 ms every 4 s) unless the scenario sets the openness.
import type { AnglePair } from '../engine/types';
import { blinkOpenness, onRoad, rel, type DriverFn, type DriverState } from './synth';

export const LEAD_S = 90;
export const EVENT_S = 100;

export interface Scenario {
  name: string;
  /** seconds in the default run, and in DMS_FULL */
  seconds: number;
  fullSeconds?: number;
  driver: DriverFn;
  localMinutes?: number | null;
}

/** An attentive driver at `speedKmh`, with `over` applied on top at each time. */
function driver(speedKmh: number, over: (t: number, r: () => number) => Partial<DriverState> | null = () => null): DriverFn {
  return (t, r) => {
    const base: DriverState = { gaze: onRoad(r), openness: blinkOpenness(t), speedKmh };
    const o = over(t, r);
    return o === null ? base : { ...base, ...o };
  };
}

/** In [t0, t0 + d)? */
const within = (t: number, t0: number, d: number) => t >= t0 && t < t0 + d;
/** A repeating window: in [phase, phase + d) of every `every` seconds after `from`. */
const every = (t: number, from: number, everyS: number, d: number, phase = 0) => t >= from && (t - from - phase + everyS) % everyS < d;
const look = (g: AnglePair, head?: AnglePair): Partial<DriverState> => ({ gaze: g, ...(head ? { head } : {}) });

// Glance targets relative to the road centre (driver frame; + yaw toward the passenger).
export const TARGET = {
  rearMirror: rel(27, 10),
  driverMirror: rel(-45, 0),
  passengerMirror: rel(52, 0),
  cluster: rel(0, -17),
  centreStack: rel(30, -20),
  lap: rel(0, -40),
  sideRight: rel(40, 0),
  sideLeft: rel(-40, 0),
  farLeft: rel(-90, 0),
};

/** A nod: the head drops `depth`° over 0.5 s, holds 0.3 s, recovers in 0.3 s; the lids low at 0.35 (under the nod's 0.5, above the 0.30 closure). */
function nodAt(t: number, t0: number, depth = 20): Partial<DriverState> | null {
  const k = t - t0;
  if (k < 0 || k >= 1.1) return null;
  const pitch = k < 0.5 ? (-depth * k) / 0.5 : k < 0.8 ? -depth : -depth + (depth * (k - 0.8)) / 0.3;
  return { head: { yaw: 0.4 * 2, pitch: -3 * 0.4 + pitch }, gaze: rel(0, pitch), openness: 0.35 };
}

/** A yawn: the MAR rises 0.08 → 0.5 over 2.5 s, holds 2.5 s, falls over 2.5 s (a slow open and close). */
function yawnMar(t: number, t0: number): number | null {
  const k = t - t0;
  if (k < 0 || k >= 7.5) return null;
  if (k < 2.5) return 0.08 + (0.42 * k) / 2.5;
  if (k < 5) return 0.5;
  return 0.5 - (0.42 * (k - 5)) / 2.5;
}

export const SCENARIOS: Scenario[] = [
  { name: 'attentive highway', seconds: 300, fullSeconds: 1800, driver: driver(100) },
  {
    name: 'mirror checks',
    seconds: 240,
    driver: driver(80, (t) => (every(t, 10, 8, 0.8) ? look(TARGET.rearMirror) : every(t, 10, 8, 0.8, 3) ? look(TARGET.driverMirror) : every(t, 10, 8, 0.6, 6) ? look(TARGET.passengerMirror) : null)),
  },
  {
    name: 'shoulder checks',
    seconds: 240,
    // A mirror glance, then 0.3 s on road, then a fast head turn over the shoulder (C-18).
    driver: driver(60, (t) => (every(t, 10, 15, 0.7) ? look(TARGET.driverMirror) : every(t, 10, 15, 1.0, 1.0) ? look(TARGET.farLeft, rel(-75, 0)) : null)),
  },
  {
    name: 'intersection side looks at 30 km/h in turns',
    seconds: 240,
    // Turning right at 12°/s at 30 km/h (a junction): looks right into the turn and left to the mirror side.
    driver: driver(30, (t) => ({
      turnDegS: t >= 100 ? 12 : 0,
      ...(every(t, 100, 6, 1.5) ? look(TARGET.sideRight) : every(t, 100, 6, 1.2, 3) ? look(TARGET.sideLeft) : {}),
    })),
  },
  { name: 'cluster checks', seconds: 240, driver: driver(80, (t) => (every(t, 10, 8, 1.0) ? look(TARGET.cluster) : null)) },
  { name: 'a 3.0 s infotainment glance', seconds: 120, driver: driver(60, (t) => (within(t, EVENT_S, 3.4) ? look(TARGET.centreStack) : null)) },
  { name: 'a 2.4 s lap glance', seconds: 120, driver: driver(60, (t) => (within(t, EVENT_S, 2.7) ? look(TARGET.lap) : null)) },
  {
    name: 'texting pattern',
    seconds: 140,
    // Three 1.3 s lap glances 6 s apart (D3 on the third), then a 2.7 s one (D1 at 2.4 s).
    driver: driver(60, (t) => (within(t, EVENT_S, 1.3) || within(t, EVENT_S + 6, 1.3) || within(t, EVENT_S + 12, 1.3) || within(t, EVENT_S + 20, 2.7) ? look(TARGET.lap) : null)),
  },
  {
    name: 'visual time-sharing',
    seconds: 150,
    // At 35 km/h (B = 6 s): 1.2 s on the centre stack, 0.9 s on the road, repeated: D2, never D1.
    driver: driver(35, (t) => (t >= EVENT_S && t < EVENT_S + 20 && (t - EVENT_S) % 2.1 < 1.2 ? look(TARGET.centreStack) : null)),
  },
  { name: 'microsleep', seconds: 120, driver: driver(60, (t) => (within(t, EVENT_S, 1.3) ? { openness: 0.1 } : null)) },
  { name: 'sleep', seconds: 120, driver: driver(60, (t) => (within(t, EVENT_S, 7) ? { openness: 0.1 } : null)) },
  {
    name: 'nodding off',
    seconds: 960,
    // Learning ends at 600 s; from 622 s a nod every 44 s, clear of the natural blinks (lids low, not
    // shut: nods, never microsleep_nod; a blink just before a nod would keep the 0.30/0.45 closure latched).
    driver: driver(80, (t) => (t >= 622 ? nodAt(t, 622 + Math.floor((t - 622) / 44) * 44) : null)),
  },
  {
    name: 'drowsy PERCLOS ramp',
    seconds: 1700,
    driver: driver(90, (t) => {
      if (t < 660) return null;
      // A: slower blinks (450 ms every 3 s). B: + long blinks (600 ms, every 3 s). C: + yawns and nods.
      const stage = t < 960 ? 'A' : t < 1260 ? 'B' : 'C';
      const k = (t - 660) % 3;
      const blinkMs = stage === 'A' ? 450 : 600;
      const o: Partial<DriverState> = { openness: k * 1000 < blinkMs ? 0.1 : 1 };
      if (stage === 'C') {
        const y = yawnMar(t, 1260 + Math.floor((t - 1260) / 50) * 50 + 10);
        if (y !== null) o.mar = y;
        const n = nodAt(t, 1260 + Math.floor((t - 1260) / 50) * 50 + 30);
        if (n !== null) Object.assign(o, n);
      }
      return o;
    }),
  },
  {
    name: 'falling asleep into LOST (C-26)',
    seconds: 120,
    // Eyes shut at 100 s while the head drops 30° in 0.5 s and stays down, then at 0.8 s the face is lost
    // for 4 s: the closure is bridged, and the looking-down gate (past −15° at every frame rate, after the
    // median-3 smoothing) carries the deep run through it: F1 at 1.5 s, F2 at 3.0 s.
    driver: driver(60, (t) =>
      t >= EVENT_S && t < EVENT_S + 0.8
        ? { openness: 0.1, gaze: rel(0, -30 * Math.min(1, (t - EVENT_S) / 0.5)), head: { yaw: 0.8, pitch: -1.2 - 30 * Math.min(1, (t - EVENT_S) / 0.5) } }
        : t >= EVENT_S + 0.8 && t < EVENT_S + 4.8
          ? { face: false }
          : null
    ),
  },
  {
    name: 'sunglasses',
    seconds: 240,
    // Lenses throughout: the irises are never found → HEAD_ONLY; two long closures behind them.
    driver: driver(60, (t) => ({ lens: true, ...(within(t, EVENT_S, 1.5) || within(t, EVENT_S + 60, 4) ? { openness: 0.1 } : {}) })),
  },
  { name: 'camera bump', seconds: 330, driver: driver(80, (t) => (t >= 150 ? { mountShift: { yaw: 9, pitch: 6 } } : null)) },
  {
    name: 'driver change',
    seconds: 330,
    // Stopped with no face for 40 s, then a different driver.
    driver: driver(60, (t) => (t >= 150 && t < 190 ? { face: false, speedKmh: 0 } : t >= 190 ? { otherDriver: true } : null)),
  },
  { name: 'driver absent', seconds: 240, driver: driver(60, () => ({ face: false })) },
];

export const REPLAY_FPS = [5, 10, 15, 30] as const;
