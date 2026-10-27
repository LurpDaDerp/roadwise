import { shallow } from 'zustand/vanilla/shallow';

import type { DriveState } from '@/drive/host';
import { selectLive } from '@/drive/useDrive';

const MPS_PER_MPH = 0.44704;

/** A recording drive's state with a limit of 35 on the sign, as the host publishes it. */
const state = (over: Partial<DriveState> = {}): DriveState =>
  ({
    status: 'recording',
    clientTripId: 't1',
    rowSpeedMps: 30 * MPS_PER_MPH,
    limitMph: 35,
    speedingRatio: 30 / 35,
    speedingOver: false,
    lastShake: null,
    lastAlert: null,
    weatherAlert: null,
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
  });

  test("the wait built afresh on every publish, and the Live Activity's weather line, are no new slice", () => {
    const wait = () => ({ since: 500, phase: 'popup' as const, deadlineAt: 2000 });
    const weather = () => ({ kind: 'dense_fog' as const, text: 'Dense fog' });
    expect(shallow(selectLive(state({ waiting: wait(), weather: weather() })), selectLive(state({ waiting: wait(), weather: weather() })))).toBe(true);
    // a new phase is
    expect(shallow(selectLive(state({ waiting: wait() })), selectLive(state({ waiting: { ...wait(), phase: 'countdown', deadlineAt: 3000 } })))).toBe(false);
  });

  test('a new row is a new slice', () => {
    expect(shallow(selectLive(state()), selectLive(state({ lastRowTs: 2000 })))).toBe(false);
  });
});
