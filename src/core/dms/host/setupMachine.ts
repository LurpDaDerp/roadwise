// The setup session's step machine (product spec v3: "a 20-second mount and gaze calibration", done while
// parked). A pure reducer over the controller's live readings, so the whole flow is testable without a camera:
//
//   mount        the face is found, both eyes tracked, enough light, the framing stable — held MOUNT_HOLD_MS
//   road         "Look at the road ahead": ROAD_MS of tracking, then the engine's C2 seed (effect 'seed')
//   left_mirror  "Glance at your left mirror"  — the gaze directions relative to the seeded road centre
//   right_mirror "… right mirror"
//   rear_mirror  "… rear-view mirror"
//   done | failed
//
// A mirror prompt that collects too few samples leaves that mirror at its default zone (never a failure). A
// seed that comes out unsteady retries the road step once. Clear failures (the setup screen's copy): no face,
// too dark, the phone moving, an unsteady gaze, or running out of time.
import type { CalibrationSeed } from '../engine/calibration';
import type { AnglePair } from '../engine/types';
import type { DmsSeedResult, DmsSetupCheck, DmsSetupGaze } from './controller';

export type MirrorPrompt = 'left_mirror' | 'right_mirror' | 'rear_mirror';
export type SetupStep = 'mount' | 'road' | MirrorPrompt;
export type SetupIssue = 'no_face' | 'eyes' | 'dark' | 'moving';
export type SetupFailure = SetupIssue | 'unsteady' | 'timeout';
export type SetupEffect = 'seed';

export const SETUP_STEPS: readonly SetupStep[] = ['mount', 'road', 'left_mirror', 'right_mirror', 'rear_mirror'];
export const MIRROR_PROMPTS: readonly MirrorPrompt[] = ['left_mirror', 'right_mirror', 'rear_mirror'];

/** The mount check must hold this long. */
export const MOUNT_HOLD_MS = 1_500;
/** The mount check has this long to pass before the setup fails with its dominant issue. */
export const MOUNT_MAX_MS = 30_000;
/** "Look at the road": this much tracking before the seed is taken (the seed uses the last 3 s). */
export const ROAD_MS = 4_000;
/** The road step is retried this many times on an unsteady seed. */
export const ROAD_RETRIES = 1;
/** Each mirror prompt lasts this long… */
export const MIRROR_MS = 3_500;
/** …and ignores its first part, while the eyes travel. */
export const MIRROR_SETTLE_MS = 700;
/** An issue (no face, dark, moving) during the road or a mirror step for this long fails the setup. */
export const ISSUE_MAX_MS = 5_000;
/** The whole setup may not take longer than this. */
export const SETUP_MAX_MS = 90_000;

export interface SetupInput {
  tMs: number;
  check: DmsSetupCheck;
  gaze: DmsSetupGaze;
  /** the answer to a 'seed' effect, on the tick after it */
  seedResult?: DmsSeedResult;
}

export interface SetupState {
  step: SetupStep | 'done' | 'failed';
  startedAt: number;
  stepSince: number;
  /** mount: since when every check passes; road: since when the eyes are tracked */
  okSince: number | null;
  /** the current issue, and since when it has held (fail timers) */
  issue: SetupIssue | null;
  issueSince: number | null;
  roadTries: number;
  /** a 'seed' effect was issued and its result is awaited */
  seedPending: boolean;
  /** the current mirror prompt's gaze samples */
  samples: AnglePair[];
  mirrors: Partial<Record<MirrorPrompt, AnglePair[]>>;
  seed: CalibrationSeed | null;
  failure: SetupFailure | null;
}

export function initialSetup(tMs: number): SetupState {
  return { step: 'mount', startedAt: tMs, stepSince: tMs, okSince: null, issue: null, issueSince: null, roadTries: 0, seedPending: false, samples: [], mirrors: {}, seed: null, failure: null };
}

/** The dominant issue of a check, in the order the driver can fix them; null when everything passes. */
export function issueOf(check: DmsSetupCheck): SetupIssue | null {
  if (check.faceVisible === false) return 'no_face';
  if (check.lightingOk === false) return 'dark';
  if (check.phoneSteady === false) return 'moving';
  if (check.bothEyesTracked === false) return 'eyes';
  return null;
}

const mountPasses = (c: DmsSetupCheck) => c.faceVisible === true && c.bothEyesTracked === true && c.lightingOk === true && c.phoneSteady !== false;

function enter(s: SetupState, step: SetupState['step'], tMs: number): SetupState {
  return { ...s, step, stepSince: tMs, okSince: null, issue: null, issueSince: null, seedPending: false, samples: [] };
}

function fail(s: SetupState, failure: SetupFailure, tMs: number): SetupState {
  return { ...enter(s, 'failed', tMs), failure };
}

/** Tracks the current issue and its duration; returns the failure it has earned, if any. */
function trackIssue(s: SetupState, check: DmsSetupCheck, tMs: number): { s: SetupState; failed: SetupFailure | null } {
  const issue = issueOf(check);
  // The eyes briefly lost (a blink, a glance down) is not a fault of the mount: only the face, the light and
  // the phone moving run the fail timer.
  const timed = issue !== null && issue !== 'eyes' ? issue : null;
  if (timed === null) return { s: { ...s, issue, issueSince: null }, failed: null };
  const since = s.issue === timed && s.issueSince !== null ? s.issueSince : tMs;
  return { s: { ...s, issue: timed, issueSince: since }, failed: tMs - since >= ISSUE_MAX_MS ? timed : null };
}

export function stepSetup(prev: SetupState, input: SetupInput): { state: SetupState; effects: SetupEffect[] } {
  const { tMs, check, gaze } = input;
  const effects: SetupEffect[] = [];
  if (prev.step === 'done' || prev.step === 'failed') return { state: prev, effects };
  if (tMs - prev.startedAt >= SETUP_MAX_MS) return { state: fail(prev, 'timeout', tMs), effects };
  let s = prev;

  switch (s.step) {
    case 'mount': {
      const ok = mountPasses(check);
      s = { ...s, issue: issueOf(check), issueSince: null, okSince: ok ? (s.okSince ?? tMs) : null };
      if (s.okSince !== null && tMs - s.okSince >= MOUNT_HOLD_MS) return { state: enter(s, 'road', tMs), effects };
      if (tMs - s.stepSince >= MOUNT_MAX_MS) return { state: fail(s, s.issue ?? 'no_face', tMs), effects };
      return { state: s, effects };
    }
    case 'road': {
      if (s.seedPending) {
        const r = input.seedResult;
        if (r === undefined) return { state: s, effects };
        if (r.ok) return { state: enter({ ...s, seed: r.seed }, 'left_mirror', tMs), effects };
        if (s.roadTries >= ROAD_RETRIES) return { state: fail(s, r.reason === 'no_tracking' ? 'eyes' : 'unsteady', tMs), effects };
        return { state: { ...enter(s, 'road', tMs), roadTries: s.roadTries + 1 }, effects };
      }
      const tracked = trackIssue(s, check, tMs);
      if (tracked.failed !== null) return { state: fail(tracked.s, tracked.failed, tMs), effects };
      s = tracked.s;
      // The seed wants the LAST seconds tracked, so a lost face restarts the hold.
      s = { ...s, okSince: gaze.tracking ? (s.okSince ?? tMs) : null };
      if (s.okSince !== null && tMs - s.okSince >= ROAD_MS) {
        effects.push('seed');
        return { state: { ...s, seedPending: true }, effects };
      }
      return { state: s, effects };
    }
    case 'left_mirror':
    case 'right_mirror':
    case 'rear_mirror': {
      const prompt: MirrorPrompt = s.step;
      const tracked = trackIssue(s, check, tMs);
      if (tracked.failed !== null) return { state: fail(tracked.s, tracked.failed, tMs), effects };
      s = tracked.s;
      const settled = tMs - s.stepSince >= MIRROR_SETTLE_MS;
      if (settled && gaze.tracking && gaze.rel !== null) s = { ...s, samples: [...s.samples, gaze.rel] };
      if (tMs - s.stepSince >= MIRROR_MS) {
        const mirrors = { ...s.mirrors, [prompt]: s.samples };
        const next = MIRROR_PROMPTS[MIRROR_PROMPTS.indexOf(prompt) + 1];
        return { state: enter({ ...s, mirrors }, next ?? 'done', tMs), effects };
      }
      return { state: s, effects };
    }
    default:
      return { state: s, effects };
  }
}

/** How far along the setup is, 0..1, for the progress ring (the steps are weighted by their nominal length). */
export function setupProgress(s: SetupState, tMs: number): number {
  const weights: Record<SetupStep, number> = { mount: MOUNT_HOLD_MS, road: ROAD_MS, left_mirror: MIRROR_MS, right_mirror: MIRROR_MS, rear_mirror: MIRROR_MS };
  const total = SETUP_STEPS.reduce((n, k) => n + weights[k], 0);
  if (s.step === 'done') return 1;
  if (s.step === 'failed') return 0;
  let before = 0;
  for (const k of SETUP_STEPS) {
    if (k === s.step) break;
    before += weights[k];
  }
  const inStep = s.step === 'mount' || s.step === 'road' ? (s.okSince === null ? 0 : tMs - s.okSince) : tMs - s.stepSince;
  return Math.max(0, Math.min(1, (before + Math.min(weights[s.step], inStep)) / total));
}
