import { shallow } from 'zustand/vanilla/shallow';

import { speedingLine } from '@scoring';

import type { DriveState } from '@/drive/host';
import { selectLive } from '@/drive/useDrive';

const MPS_PER_MPH = 0.44704;

/** A recording drive's state with a limit of 35 on the sign (on a normal road: the judged limit is the sign's), as the host publishes it. */
const state = (over: Partial<DriveState> = {}): DriveState =>
  ({
    status: 'recording',
    clientTripId: 't1',
    rowSpeedMps: 30 * MPS_PER_MPH,
    limitMph: 35,
    judgedLimitMph: over.limitMph ?? 35,
    speedingRatio: 30 / 35,
    speedingOver: false,
    speedingTier: null,
    speedingWeather: null,
    lastShake: null,
    lastAlert: null,
    weatherAlert: null,
    weatherRoad: null,
    weather: null,
    lastRowTs: 1000,
    waiting: null,
    notDrivingAvailable: true,
    spotNudge: null,
    courseDeg: 90,
    ...over,
  }) as DriveState;

describe('selectLive: the driving screen re-renders only for what it draws', () => {
  test('a fix under the limit changes nothing it draws: no new slice', () => {
    expect(shallow(selectLive(state({ speedingRatio: 30 / 35 })), selectLive(state({ speedingRatio: 33 / 35 })))).toBe(true);
    // at the limit, and with the sign at "-", the same
    expect(shallow(selectLive(state({ speedingRatio: 1 })), selectLive(state({ speedingRatio: null })))).toBe(true);
  });

  test('over the limit the tint follows each reading, and the spoken speed says so', () => {
    const a = selectLive(state({ speedingRatio: 40 / 35 }));
    const b = selectLive(state({ speedingRatio: 42 / 35 }));
    expect(shallow(a, b)).toBe(false);
    expect(a.speedingTint).toBeGreaterThan(0);
    expect(b.speedingTint).toBeGreaterThan(a.speedingTint);
    expect(a.overSign).toBe(true);
    expect(selectLive(state({ speedingRatio: 30 / 35 }))).toMatchObject({ speedingTint: 0, overSign: false });
    // Half way to red at the speeding line of the limit the sign shows (39.8 on a 35, 28.2 on a 25).
    expect(selectLive(state({ speedingRatio: 39.8 / 35 })).speedingTint).toBeCloseTo(0.5, 9);
    expect(selectLive(state({ limitMph: 25, speedingRatio: 28.2 / 25 })).speedingTint).toBeCloseTo(0.5, 9);
  });

  test("the wait built afresh on every publish, and the Live Activity's weather line, are no new slice", () => {
    const wait = () => ({ since: 500, phase: 'popup' as const, deadlineAt: 2000 });
    const weather = () => ({ kind: 'dense_fog' as const, text: 'Dense fog' });
    expect(shallow(selectLive(state({ waiting: wait(), weather: weather() })), selectLive(state({ waiting: wait(), weather: weather() })))).toBe(true);
    // a new phase is
    expect(shallow(selectLive(state({ waiting: wait() })), selectLive(state({ waiting: { ...wait(), phase: 'countdown', deadlineAt: 3000 } })))).toBe(false);
  });

  test('on a road whose weather lowered the limit the tint starts at the judged limit and is half way at its line; the spoken speed still says over the sign only past the sign', () => {
    // A wet 35: judged at 31.5, its line 35.7; the ratio is the speed over the judged limit.
    const wet = (mph: number) => state({ judgedLimitMph: 31.5, speedingRatio: mph / 31.5 });
    expect(selectLive(wet(31)).speedingTint).toBe(0);
    expect(selectLive(wet(33))).toMatchObject({ overSign: false });
    expect(selectLive(wet(33)).speedingTint).toBeGreaterThan(0);
    expect(selectLive(wet(speedingLine(31.5))).speedingTint).toBeCloseTo(0.5, 9);
    expect(selectLive(wet(36)).overSign).toBe(true);
    // On a normal road the judged limit is the sign's: the same numbers as with no road state.
    expect(selectLive(state({ speedingRatio: 39.8 / 35 }))).toEqual(selectLive(state({ judgedLimitMph: 35, speedingRatio: 39.8 / 35 })));
  });

  test('the road card held by the host is no new slice', () => {
    const road = { road: { g: 'wet' as const }, title: 'Wet roads' };
    expect(shallow(selectLive(state({ weatherRoad: road })), selectLive(state({ weatherRoad: road })))).toBe(true);
    expect(selectLive(state({ weatherRoad: road })).weatherRoad).toBe(road);
  });

  test('the weather "Slow down" hold goes to the screen with its condition', () => {
    expect(selectLive(state({ speedingOver: true, speedingWeather: 'fog' }))).toMatchObject({ speedingOver: true, speedingTier: null, speedingWeather: 'fog' });
    expect(selectLive(state()).speedingWeather).toBeNull();
    expect(shallow(selectLive(state({ speedingWeather: 'wet' })), selectLive(state({ speedingWeather: 'wet' })))).toBe(true);
    expect(shallow(selectLive(state({ speedingWeather: 'wet' })), selectLive(state({ speedingWeather: 'water' })))).toBe(false);
  });

  test('a new row is a new slice', () => {
    expect(shallow(selectLive(state()), selectLive(state({ lastRowTs: 2000 })))).toBe(false);
  });
});
