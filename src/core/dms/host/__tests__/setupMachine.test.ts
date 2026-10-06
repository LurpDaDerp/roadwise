// The setup's step machine (spec: the 20-second mount and gaze calibration), as a pure reducer.
import type { DmsSetupCheck, DmsSetupGaze } from '../controller';
import {
  initialSetup,
  ISSUE_MAX_MS,
  issueOf,
  MIRROR_MS,
  MIRROR_SETTLE_MS,
  MOUNT_HOLD_MS,
  MOUNT_MAX_MS,
  ROAD_MS,
  SETUP_MAX_MS,
  setupProgress,
  stepSetup,
  type SetupInput,
  type SetupState,
} from '../setupMachine';

const T0 = 1_760_000_000_000;
const good: DmsSetupCheck = { faceVisible: true, bothEyesTracked: true, lightingOk: true, angleOk: true, phoneSteady: true };
const unknown: DmsSetupCheck = { faceVisible: 'unknown', bothEyesTracked: 'unknown', lightingOk: 'unknown', angleOk: 'unknown', phoneSteady: 'unknown' };
const tracking: DmsSetupGaze = { rel: { yaw: 0, pitch: 0 }, tracking: true };
const lost: DmsSetupGaze = { rel: null, tracking: false };
const SEED = { gazeCentres: { geometric: { yaw: 0, pitch: 0 }, net: null }, headCentre: { yaw: 0, pitch: 0 }, rollOffsetDeg: 0, mount: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, boxCx: 0.5, boxCy: 0.5, iod: 0.2 }, orientation: 90 as const, openEyeEar: { r: 0.3, l: 0.3 } };

/** Runs the machine every 100 ms (every constant is on that grid) up to `untilMs` with a constant input; the effects are answered with `seed`. */
function run(s: SetupState, fromMs: number, untilMs: number, input: Omit<SetupInput, 'tMs'>, seed: SetupInput['seedResult'] = { ok: true, seed: SEED }) {
  let state = s;
  let pending: SetupInput['seedResult'] | undefined;
  const effects: string[] = [];
  for (let t = fromMs; t <= untilMs; t += 100) {
    const r = stepSetup(state, { tMs: T0 + t, ...input, ...(pending !== undefined ? { seedResult: pending } : {}) });
    pending = undefined;
    state = r.state;
    for (const e of r.effects) {
      effects.push(e);
      pending = seed;
    }
  }
  return { state, effects };
}

test('the happy path: mount held 1.5 s → road 4 s → seed → three mirrors of 3.5 s → done, with each mirror’s samples', () => {
  let s = initialSetup(T0);
  expect(s.step).toBe('mount');
  s = run(s, 0, MOUNT_HOLD_MS - 100, { check: good, gaze: tracking }).state;
  expect(s.step).toBe('mount');
  s = run(s, MOUNT_HOLD_MS, MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  expect(s.step).toBe('road');
  const road = run(s, MOUNT_HOLD_MS + 200, MOUNT_HOLD_MS + ROAD_MS + 400, { check: good, gaze: tracking });
  expect(road.effects).toEqual(['seed']);
  s = road.state;
  expect(s.step).toBe('left_mirror');
  expect(s.seed).toEqual(SEED);
  const t1 = s.stepSince - T0;
  s = run(s, t1 + 200, t1 + MIRROR_MS, { check: good, gaze: { rel: { yaw: -40, pitch: 0 }, tracking: true } }).state;
  expect(s.step).toBe('right_mirror');
  expect(s.mirrors.left_mirror!.length).toBeGreaterThanOrEqual((MIRROR_MS - MIRROR_SETTLE_MS) / 100 - 2);
  expect(s.mirrors.left_mirror!.every((a) => a.yaw === -40)).toBe(true);
  const t2 = s.stepSince - T0;
  s = run(s, t2 + 200, t2 + MIRROR_MS, { check: good, gaze: { rel: { yaw: 50, pitch: 0 }, tracking: true } }).state;
  expect(s.step).toBe('rear_mirror');
  const t3 = s.stepSince - T0;
  s = run(s, t3 + 200, t3 + MIRROR_MS, { check: good, gaze: { rel: { yaw: 27, pitch: 10 }, tracking: true } }).state;
  expect(s.step).toBe('done');
  expect(Object.keys(s.mirrors).sort()).toEqual(['left_mirror', 'rear_mirror', 'right_mirror']);
  expect(setupProgress(s, T0 + t3 + MIRROR_MS)).toBe(1);
  // Done is terminal.
  expect(stepSetup(s, { tMs: T0 + 60_000, check: unknown, gaze: lost }).state).toBe(s);
});

test('the mount check: a failing check resets the hold; the eyes briefly lost are an issue, not a reset of the whole flow', () => {
  let s = initialSetup(T0);
  s = run(s, 0, 1000, { check: good, gaze: tracking }).state;
  expect(s.okSince).toBe(T0);
  s = run(s, 1100, 1100, { check: { ...good, faceVisible: false }, gaze: lost }).state;
  expect(s.okSince).toBeNull();
  expect(s.issue).toBe('no_face');
  s = run(s, 1200, 1200 + MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  expect(s.step).toBe('road');
});

test('issueOf: the dominant issue in the order the driver can fix them', () => {
  expect(issueOf(good)).toBeNull();
  expect(issueOf(unknown)).toBeNull();
  expect(issueOf({ ...good, faceVisible: false, lightingOk: false })).toBe('no_face');
  expect(issueOf({ ...good, lightingOk: false, phoneSteady: false })).toBe('dark');
  expect(issueOf({ ...good, phoneSteady: false, bothEyesTracked: false })).toBe('moving');
  expect(issueOf({ ...good, bothEyesTracked: false })).toBe('eyes');
});

test(`the mount check never passing fails after ${MOUNT_MAX_MS / 1000} s with the dominant issue`, () => {
  const s = run(initialSetup(T0), 0, MOUNT_MAX_MS, { check: { ...good, lightingOk: false }, gaze: tracking }).state;
  expect(s.step).toBe('failed');
  expect(s.failure).toBe('dark');
});

test('during the road or a mirror step, a face lost (or the dark, or the phone moving) for 5 s fails; a brief loss only pauses the road hold', () => {
  const road = run(initialSetup(T0), 0, MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  expect(road.step).toBe('road');
  const brief = run(road, MOUNT_HOLD_MS + 200, MOUNT_HOLD_MS + 1200, { check: { ...good, faceVisible: false }, gaze: lost }).state;
  expect(brief.step).toBe('road');
  expect(brief.okSince).toBeNull();
  const after = run(brief, MOUNT_HOLD_MS + 1400, MOUNT_HOLD_MS + 1400 + ROAD_MS, { check: good, gaze: tracking });
  expect(after.effects).toEqual(['seed']);
  const gone = run(road, MOUNT_HOLD_MS + 200, MOUNT_HOLD_MS + 200 + ISSUE_MAX_MS, { check: { ...good, phoneSteady: false }, gaze: lost }).state;
  expect(gone.step).toBe('failed');
  expect(gone.failure).toBe('moving');
});

test('an unsteady seed retries the road step once, then fails as unsteady; no_tracking fails as eyes', () => {
  const road = run(initialSetup(T0), 0, MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  const t = MOUNT_HOLD_MS;
  const first = run(road, t + 200, t + ROAD_MS + 400, { check: good, gaze: tracking }, { ok: false, reason: 'unsteady' });
  expect(first.effects).toEqual(['seed']);
  expect(first.state.step).toBe('road');
  expect(first.state.roadTries).toBe(1);
  const t2 = first.state.stepSince - T0;
  const second = run(first.state, t2 + 200, t2 + ROAD_MS + 400, { check: good, gaze: tracking }, { ok: false, reason: 'unsteady' });
  expect(second.state.step).toBe('failed');
  expect(second.state.failure).toBe('unsteady');
  const eyes = run(first.state, t2 + 200, t2 + ROAD_MS + 400, { check: good, gaze: tracking }, { ok: false, reason: 'no_tracking' });
  expect(eyes.state.failure).toBe('eyes');
});

test('a mirror prompt samples only tracked frames after the settle time; a prompt with no samples still moves on', () => {
  const road = run(initialSetup(T0), 0, MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  const t = MOUNT_HOLD_MS;
  const mirror = run(road, t + 200, t + ROAD_MS + 400, { check: good, gaze: tracking }).state;
  expect(mirror.step).toBe('left_mirror');
  const t1 = mirror.stepSince - T0;
  const early = run(mirror, t1 + 100, t1 + MIRROR_SETTLE_MS - 100, { check: good, gaze: { rel: { yaw: -40, pitch: 0 }, tracking: true } }).state;
  expect(early.samples).toEqual([]);
  const none = run(mirror, t1 + 200, t1 + MIRROR_MS, { check: good, gaze: lost }).state;
  expect(none.step).toBe('right_mirror');
  expect(none.mirrors.left_mirror).toEqual([]);
});

test(`the whole setup times out at ${SETUP_MAX_MS / 1000} s`, () => {
  const s = run(initialSetup(T0), 0, MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  const late = stepSetup(s, { tMs: T0 + SETUP_MAX_MS, check: good, gaze: lost }).state;
  expect(late.step).toBe('failed');
  expect(late.failure).toBe('timeout');
});

test('progress grows through the steps and is 0 on a failure', () => {
  const s0 = initialSetup(T0);
  expect(setupProgress(s0, T0)).toBe(0);
  const mount = run(s0, 0, 1000, { check: good, gaze: tracking }).state;
  expect(setupProgress(mount, T0 + 1000)).toBeGreaterThan(0);
  const road = run(s0, 0, MOUNT_HOLD_MS, { check: good, gaze: tracking }).state;
  expect(setupProgress(road, T0 + MOUNT_HOLD_MS)).toBeCloseTo(MOUNT_HOLD_MS / (MOUNT_HOLD_MS + ROAD_MS + 3 * MIRROR_MS), 6);
  const failed = run(s0, 0, MOUNT_MAX_MS, { check: { ...good, faceVisible: false }, gaze: lost }).state;
  expect(setupProgress(failed, T0 + MOUNT_MAX_MS)).toBe(0);
});
