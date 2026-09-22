import { CONSTANTS } from '@scoring';
import type { MotionActivity } from '@drive-sense';

import { row } from '@/core/detectors/__fixtures__/rows';
import type { EngineSnapshot } from '@/core/engine/engine.types';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import {
  ALERT_SHOWN_MS,
  activityEvent,
  captureCommands,
  capturePlan,
  createNightClock,
  detectorContext,
  endDriveAllowed,
  gpsQuality,
  isBusyStatus,
  isShortDrive,
  l1RespectsSilentSwitch,
  limitOptions,
  notificationStateOf,
  shouldArm,
  shouldSelfDispatch,
  wakeStart,
} from '@/drive/policy';

const T = 1_700_000_000_000;
const act = (
  type: MotionActivity['type'],
  s: number,
  confidence: MotionActivity['confidence'] = 'high'
): MotionActivity => ({ type, confidence, ts: T + s * 1000 });

function snap(over: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    status: 'recording',
    mode: 'mounted',
    role: 'driver',
    clientTripId: 't',
    startedAt: T,
    lastRowTs: T,
    speedMps: 10,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: true,
    stoppedPanel: false,
    ...over,
  };
}

describe('capture plan (§3.5, rev1 I5)', () => {
  test('candidate and recording capture at full rate in the trip mode', () => {
    expect(capturePlan('candidate', 'auto')).toEqual({ on: true, rate: 'full', mode: 'auto' });
    expect(capturePlan('recording', 'mounted')).toEqual({ on: true, rate: 'full', mode: 'mounted' });
  });

  test('ending drops to the low rate: no IMU, coarse location', () => {
    expect(capturePlan('ending', 'pocket')).toEqual({ on: true, rate: 'low', mode: 'pocket' });
  });

  test('armed and off capture nothing; finalizing keeps what is running', () => {
    expect(capturePlan('armed', 'auto')).toEqual({ on: false });
    expect(capturePlan('off', 'auto')).toEqual({ on: false });
    expect(capturePlan('finalizing', 'mounted')).toBe('keep');
  });

  test('commands: start claims and sets the rate; a rate change is one call; stop is one call', () => {
    const off = { on: false, rate: null, mode: null } as const;
    expect(captureCommands(off, { on: true, rate: 'full', mode: 'mounted' })).toEqual([
      { type: 'startCapture', mode: 'mounted' },
      { type: 'setCaptureRate', rate: 'full' },
    ]);
    const full = { on: true, rate: 'full', mode: 'mounted' } as const;
    expect(captureCommands(full, { on: true, rate: 'low', mode: 'mounted' })).toEqual([
      { type: 'setCaptureRate', rate: 'low' },
    ]);
    expect(captureCommands({ ...full, rate: 'low' }, { on: true, rate: 'full', mode: 'mounted' })).toEqual([
      { type: 'setCaptureRate', rate: 'full' },
    ]);
    expect(captureCommands(full, { on: false })).toEqual([{ type: 'stopCapture' }]);
    expect(captureCommands(off, { on: false })).toEqual([]);
    expect(captureCommands(full, 'keep')).toEqual([]);
    expect(captureCommands(full, { on: true, rate: 'full', mode: 'mounted' })).toEqual([]);
  });

  test('a mode change mid-trip re-claims with the new mode and nothing else', () => {
    const full = { on: true, rate: 'full', mode: 'auto' } as const;
    expect(captureCommands(full, { on: true, rate: 'full', mode: 'mounted' })).toEqual([
      { type: 'startCapture', mode: 'mounted' },
    ]);
  });

  test('a capture native started (rate unknown) is claimed and its rate set', () => {
    const native = { on: true, rate: null, mode: null } as const;
    expect(captureCommands(native, { on: true, rate: 'full', mode: 'auto' })).toEqual([
      { type: 'startCapture', mode: 'auto' },
      { type: 'setCaptureRate', rate: 'full' },
    ]);
  });
});

describe('wakes: the motion history decides (§8.5, Appendix A)', () => {
  test('no history, or nothing automotive, opens nothing', () => {
    expect(wakeStart([])).toBeNull();
    expect(wakeStart([act('stationary', -60), act('walking', -30)])).toBeNull();
  });

  test('automotive gives the start of the latest automotive run as the backfill', () => {
    expect(wakeStart([act('automotive', -120), act('automotive', -60)])).toBe(T - 120_000);
    expect(wakeStart([act('walking', -170), act('automotive', -90), act('stationary', -30)])).toBe(
      T - 90_000
    );
  });

  test('walking at medium or above after the drive means the drive is over', () => {
    expect(wakeStart([act('automotive', -120), act('walking', -10, 'medium')])).toBeNull();
  });

  test('low-confidence walking is not evidence either way', () => {
    expect(wakeStart([act('automotive', -120), act('walking', -10, 'low')])).toBe(T - 120_000);
  });

  test('unsorted history is read in time order', () => {
    expect(wakeStart([act('automotive', -60), act('walking', -150), act('automotive', -100)])).toBe(
      T - 100_000
    );
  });
});

describe('activity events', () => {
  test('automotive at any confidence is automotive, with its own time as the backfill', () => {
    expect(activityEvent(act('automotive', 0, 'low'), T + 5)).toEqual({
      type: 'activity',
      automotive: true,
      walking: false,
      ts: T + 5,
      candidateStartTs: T,
    });
  });

  test('walking and running count only at medium or above (rev1: m)', () => {
    expect(activityEvent(act('walking', 0, 'low'), T)).toBeNull();
    expect(activityEvent(act('running', 0, 'low'), T)).toBeNull();
    expect(activityEvent(act('walking', 0, 'medium'), T)).toEqual({
      type: 'activity',
      automotive: false,
      walking: true,
      ts: T,
    });
    expect(activityEvent(act('running', 0, 'high'), T)?.walking).toBe(true);
  });

  test('stationary, cycling and unknown say nothing', () => {
    for (const type of ['stationary', 'cycling', 'unknown'] as const) {
      expect(activityEvent(act(type, 0), T)).toBeNull();
    }
  });
});

describe('post-gap self-dispatch (M1 note)', () => {
  test('armed and a row faster than the lockout: the host opens the candidate itself', () => {
    const fast = row({ speed: CONSTANTS.LOCKOUT_SPEED_MPS + 1 });
    expect(shouldSelfDispatch('armed', fast)).toBe(true);
  });

  test('not when slow, without a valid fix, or in any other state', () => {
    expect(shouldSelfDispatch('armed', row({ speed: 1 }))).toBe(false);
    expect(shouldSelfDispatch('armed', row({ speed: 20, gnssValid: false }))).toBe(false);
    expect(shouldSelfDispatch('off', row({ speed: 20 }))).toBe(false);
    expect(shouldSelfDispatch('candidate', row({ speed: 20 }))).toBe(false);
    expect(shouldSelfDispatch('recording', row({ speed: 20 }))).toBe(false);
  });
});

describe('the drive notification', () => {
  test('stationary while stopped or in the gap window; startedAt from the trip', () => {
    expect(notificationStateOf(snap())).toEqual({ stationary: false, startedAt: T });
    expect(notificationStateOf(snap({ stationarySinceTs: T }))).toEqual({ stationary: true, startedAt: T });
    expect(notificationStateOf(snap({ status: 'ending' }))).toEqual({ stationary: true, startedAt: T });
    expect(notificationStateOf(snap({ status: 'candidate', startedAt: null, clientTripId: null }))).toEqual({
      stationary: false,
      startedAt: null,
    });
  });

  test('the End action is honoured only while stationary', () => {
    expect(endDriveAllowed(snap())).toBe(false);
    expect(endDriveAllowed(snap({ stationarySinceTs: T }))).toBe(true);
    expect(endDriveAllowed(snap({ status: 'ending' }))).toBe(true);
    expect(endDriveAllowed(snap({ status: 'armed', stationarySinceTs: T }))).toBe(false);
  });
});

describe('detector context', () => {
  test('the lock signal sets both flags: unreliable is never evidence, lagged waits 12 s', () => {
    expect(detectorContext(false, 'reliable')).toEqual({
      night: false,
      precipitation: false,
      lockReliable: true,
      lockLagged: false,
    });
    expect(detectorContext(true, 'lagged')).toMatchObject({ night: true, lockReliable: true, lockLagged: true });
    expect(detectorContext(false, 'unreliable')).toMatchObject({ lockReliable: false, lockLagged: false });
  });

  test('night is the clock rule in the zone, computed at most once a minute', () => {
    const format = jest.spyOn(Intl, 'DateTimeFormat');
    const clock = createNightClock(CONSTANTS);
    // 2023-11-14T22:13Z is 14:13 in Los Angeles, 23:13 in Berlin.
    const minute = Math.floor(T / 60_000) * 60_000;
    expect(clock.at(minute, 'America/Los_Angeles')).toBe(false);
    const calls = format.mock.calls.length;
    for (let s = 1; s < 60; s += 1) clock.at(minute + s * 1000, 'America/Los_Angeles');
    expect(format.mock.calls.length).toBe(calls);
    expect(clock.at(T, 'Europe/Berlin')).toBe(true);
    format.mockRestore();
  });
});

describe('small rules', () => {
  test('busy means a drive is open or closing', () => {
    expect(['candidate', 'recording', 'ending', 'finalizing'].every((s) => isBusyStatus(s as never))).toBe(true);
    expect(isBusyStatus('armed')).toBe(false);
    expect(isBusyStatus('off')).toBe(false);
  });

  test('arming needs the flag, the user setting and Always location', () => {
    expect(shouldArm({ intent: true, flag: true, location: 'always' })).toBe(true);
    expect(shouldArm({ intent: false, flag: true, location: 'always' })).toBe(false);
    expect(shouldArm({ intent: true, flag: false, location: 'always' })).toBe(false);
    expect(shouldArm({ intent: true, flag: true, location: 'whenInUse' })).toBe(false);
  });

  test('L1 honours the silent switch only when mounted, unlocked and RoadWise is in front', () => {
    expect(l1RespectsSilentSwitch({ mode: 'mounted', screenLocked: false }, true)).toBe(true);
    expect(l1RespectsSilentSwitch({ mode: 'mounted', screenLocked: true }, true)).toBe(false);
    expect(l1RespectsSilentSwitch({ mode: 'mounted', screenLocked: false }, false)).toBe(false);
    expect(l1RespectsSilentSwitch({ mode: 'pocket', screenLocked: false }, true)).toBe(false);
    expect(l1RespectsSilentSwitch({ mode: 'auto', screenLocked: false }, true)).toBe(false);
  });

  test('gps quality from the current row', () => {
    expect(gpsQuality(null)).toBe('none');
    expect(gpsQuality(row({ gnssValid: false }))).toBe('none');
    expect(gpsQuality(row({ hAcc: 30 }))).toBe('weak');
    expect(gpsQuality(row({ speedAcc: 3 }))).toBe('weak');
    expect(gpsQuality(row())).toBe('good');
  });

  test('alert overlay durations: L1 3 s, L2 5 s, L3 8 s', () => {
    expect(ALERT_SHOWN_MS).toEqual({ 1: 3000, 2: 5000, 3: 8000 });
  });

  test('limit lookup options come from the row itself', () => {
    expect(limitOptions(row({ speed: 12 }))).toEqual({ gnssValid: true, speedMps: 12 });
    expect(limitOptions(row({ speed: -1, gnssValid: false }))).toEqual({ gnssValid: false, speedMps: null });
    expect(limitOptions(row({ speed: 12, gnssValid: false }))).toEqual({ gnssValid: false, speedMps: null });
  });

  test('a short drive is under either scoring minimum', () => {
    expect(isShortDrive({ distance_m: 100, duration_s: 600 }, CONSTANTS)).toBe(true);
    expect(isShortDrive({ distance_m: 5000, duration_s: 60 }, CONSTANTS)).toBe(true);
    expect(isShortDrive({ distance_m: 5000, duration_s: 600 }, CONSTANTS)).toBe(false);
    expect(isShortDrive({ distance_m: null, duration_s: null }, CONSTANTS)).toBe(true);
  });
});
