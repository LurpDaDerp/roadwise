// The alert manager (plan §M8; spec "Alert manager"). It turns the rules' alert requests into one audible
// state at a time and the host's commands. Pure; the frame clock and the epoch time are the caller's.
//
// Tiers: 1 advisory (`once`); 2 distraction (`start` … `stop`; the host repeats every tier2RepeatS) or a
// fatigue burst (`once`); 3 Critical (`start` … `stop`; the host gets louder every tier3LouderEveryS).
// Priority: Critical > Tier 2 distraction > Tier 2 fatigue burst > Tier 1. A burst or Tier 1 held back
// by a running Critical or distraction waits ≤ heldBackMaxS (10 s), then is logged `dropped`; a
// distraction request during a Critical is dropped at once.
//
// Anti-annoyance rules:
//  1. A Tier 2 distraction stops on the first on-road frame.
//  2. The next D1 only after f ≥ 0.5: attention.ts (d1_rearmed). A request while one runs is merged.
//  3. Tier 1 at most once per tier1EveryS (10 min) per type; fatigue's own timers are in fatigue.ts.
//  4. Nothing audible below 20 km/h (Tier 1 and 2; a running distraction stops), with one exception: the
//     Tier 1 `monitoring_paused` at a blind cap plays at any speed, since it replaces a Tier 3 sound that was
//     already playing and tells the driver why it stopped (T13 r1 nit; rule 3's rate still applies). A NEW Critical may start
//     at ≥ 10 km/h; an ESCALATION (D4 after a D1/D2 warning, F3 in an F1/F2 episode, F3's no-on-road
//     clause) skips that gate (T8 R1-I1, rev1 I6; T11 review I1). A Critical continues through a
//     slowdown and through LOST, and ends on its stop condition (the eyes open AND on road for
//     tier3ClearS) or after a KNOWN speed < 10 km/h held criticalEndAfterS. An unknown, held or
//     inferred speed never ends it (rev1 I6; T8 review m4: `speedKnown`). An escalation must be
//     corroborated (T11 round 2): a Critical is running, or a distraction/cumulative request arrived (any
//     outcome) with no on-road frame and no known < 10 km/h for 5 s since (D4's pending state). An
//     uncorroborated one is STILL delivered, never gated, and logged `escalation_unverified` in
//     `invariantViolations`.
//  5. No distraction alert from a LOST frame except C-8 (`c8`): Tier 1/2 is suppressed. A closure Critical
//     on HEAD_ONLY/LOST needs a C-26 bridge, and a non-closure `unresponsive` on LOST needs C-8. The
//     rules already hold this, so for Tier 3 a mismatch is a façade bug: it FAILS LOUD (delivered,
//     logged `rule5_violation`, counted in `invariantViolations`), never silent (T11 review I2).
//  6. Warm-up: only Critical and D1 (`distraction`).
//  7. tagLastAlert('wrong') tags the last logged alert and never changes live behaviour.
//  8. Three Tier 2 distraction warnings the driver HEARD (delivered starts; merged requests don't count,
//     T11 review m2) within 10 min → one Tier 1 `repeated_glances` with an event flag, instead of any
//     louder tier; the count then restarts.
//  9. Sensitivity (C-20) scales D1's buffer in attention.ts.
// Shadow mode decides everything the same and marks every command `muted`. `stopAll` ends the session's
// sound (drive end, opt-out or revoke, sign-out, engine reset; T11 review m1). `cameraOff` is NOT a
// session end (T13 r1 I1): the camera going off at speed (heat, dark) stops a running distraction and drops
// the held items, but KEEPS a running Critical (the phone's heat says nothing about the driver); it then
// ends on a known < 10 km/h for 5 s, on its clear condition once frames return, or after
// criticalBlindMaxS with no frame (blind_cap), followed by one Tier 1 `monitoring_paused`. The blind cap is
// measured from the LAST FRAME (the façade's blind ticks carry `blindSinceMs`; final review I2), so frames
// that simply stop are capped too (cause `fault` when no cameraOff named one), and a late in-flight frame
// moves it only by its own lateness. U-23 (final review I3): a Critical with no TRACKING face for
// criticalLostMaxS (LOST, HEAD_ONLY or blind, continuously; only TRACKING resets it) stops (lost_cap) with
// one `monitoring_paused` (cause face_lost); a returning face may raise a new Critical by the normal rules.
import type { DmsConfig } from './config';
import type { Quality } from './quality';
import { RingBuffer } from './windows';

export type AlertKind =
  | 'distraction'
  | 'cumulative'
  | 'phone_pattern'
  | 'unresponsive'
  | 'microsleep'
  | 'microsleep_nod'
  | 'sleep'
  | 'fatigue_early'
  | 'fatigue'
  | 'repeated_glances'
  /** T13 r1 I1: a Critical stopped after criticalBlindMaxS with the camera off (heat or dark) */
  | 'monitoring_paused';

export const ALERT_KINDS: readonly AlertKind[] = ['distraction', 'cumulative', 'phone_pattern', 'unresponsive', 'microsleep', 'microsleep_nod', 'sleep', 'fatigue_early', 'fatigue', 'repeated_glances', 'monitoring_paused'];

/** Why the camera went off at speed: heat (thermal L3), the dark (the low-light suspend) or a native fault (T14 r2 R1-m1). */
export type CameraOffCause = 'heat' | 'dark' | 'fault';
/** Why `monitoring_paused` played: the camera went off (a CameraOffCause), or no TRACKING face (U-23). */
export type PausedCause = CameraOffCause | 'face_lost';

export interface DmsAlertCommand {
  id: number;
  action: 'start' | 'stop' | 'once';
  tier: 1 | 2 | 3;
  kind: AlertKind;
  tMs: number;
  epochMs: number;
  muted: boolean;
  /** `monitoring_paused`: why monitoring paused */
  cause?: PausedCause;
}

/**
 * A rule's request. The flags rule 5 and the start gate read are REQUIRED by type, so the façade cannot
 * omit one (T11 review I2).
 */
export type AlertRequest =
  /** F1, F2, microsleep_nod: always closure rules; `bridged` = raised through a C-26 bridge */
  | { kind: 'microsleep' | 'sleep' | 'microsleep_nod'; bridged: boolean }
  /**
   * F3 (closure: its closure clause), F3's no-on-road clause, or D4. `escalation`: D4 after a D1/D2
   * warning, F3 in an F1/F2 episode, F3's no-on-road clause. `c8`: raised on a C-8 far-lateral LOST frame.
   */
  | { kind: 'unresponsive'; closure: boolean; bridged: boolean; c8: boolean; escalation: boolean }
  /** D1, D2 */
  | { kind: 'distraction' | 'cumulative'; c8: boolean }
  | { kind: 'phone_pattern' | 'fatigue_early' | 'fatigue' | 'repeated_glances' };

export interface AlertFrame {
  tMs: number;
  epochMs: number;
  /** ContextState.ruleSpeedKmh: known, or held (tunnel); null = none */
  ruleSpeedKmh: number | null;
  /** ContextState.speedKnown: only a known low speed ends a Critical */
  speedKnown: boolean;
  quality: Quality;
  /** the gaze is on road centre or forward road */
  onRoad: boolean;
  /** TRACKING with the eyes open */
  eyesOpen: boolean;
  warmup: boolean;
  requests: readonly AlertRequest[];
  /** a tick with no camera frame (the façade's 1 Hz row tick while no frame came for a row period) */
  blind?: boolean;
  /**
   * a blind tick: the time of the last camera frame (final review I2). The blind cap is measured from it, so
   * it is armed by the absence of frames, whether or not cameraOff was called, and a late in-flight frame
   * only moves it by its own lateness. Absent before any frame.
   */
  blindSinceMs?: number;
  /** this frame came after a frame gap (final review m9): the clear condition restarts */
  gap?: boolean;
}

export type AlertOutcome = 'delivered' | 'muted' | 'merged' | 'dropped' | 'suppressed';

export interface AlertLogEntry {
  kind: AlertKind;
  tier: 1 | 2 | 3;
  tMs: number;
  outcome: AlertOutcome;
  /** why it was suppressed or dropped, or the invariant a delivered Critical broke */
  why?: 'speed' | 'warmup' | 'rule5' | 'rule5_violation' | 'escalation_unverified' | 'tier1_rate' | 'held_too_long' | 'critical_running' | 'session_end' | 'camera_off' | 'blind_cap' | 'lost_cap';
  /** rule 8's event flag */
  flag?: boolean;
  /** rule 7 */
  tag?: 'wrong';
  /** the quality of the frame that RAISED the request (rule 5 at request time, T12 review m2) */
  quality?: Quality;
  /** the request's C-8 flag (D1/D2, D4) */
  c8?: boolean;
}

export type AlertCounts = Record<AlertOutcome, number>;

export interface AlertStats {
  byKind: Record<AlertKind, AlertCounts>;
  log: AlertLogEntry[];
  /** Tier 3 rule-5 mismatches and uncorroborated escalations, delivered anyway (a façade bug); the replay asserts 0 */
  invariantViolations: number;
}

const CRITICAL: ReadonlySet<AlertKind> = new Set(['unresponsive', 'microsleep', 'microsleep_nod', 'sleep']);
const DISTRACTION: ReadonlySet<AlertKind> = new Set(['distraction', 'cumulative']);

/** A Critical's rank: several on one frame start only the highest (final review round 3 nit). */
const CRITICAL_RANK: Partial<Record<AlertKind, number>> = { microsleep: 1, microsleep_nod: 1, sleep: 2, unresponsive: 3 };
const rankOf = (req: AlertRequest) => CRITICAL_RANK[req.kind] ?? 0;

export function tierOf(kind: AlertKind): 1 | 2 | 3 {
  if (CRITICAL.has(kind)) return 3;
  if (DISTRACTION.has(kind) || kind === 'fatigue') return 2;
  return 1;
}

/** Rule 5 for a request on this frame: true when it holds. */
function rule5Holds(req: AlertRequest, quality: Quality): boolean {
  switch (req.kind) {
    case 'microsleep':
    case 'sleep':
      return quality === 'tracking' || req.bridged;
    case 'microsleep_nod':
      // Final review m4: the nod's deep-lid evidence was TRACKING (the detector needs a known openness during
      // the drop); a fast recovery may blur its last frame into HEAD_ONLY. Only an unbridged LOST frame breaks it.
      return quality !== 'lost' || req.bridged;
    case 'unresponsive':
      if (req.closure) return quality === 'tracking' || req.bridged;
      return quality !== 'lost' || req.c8;
    case 'distraction':
    case 'cumulative':
      return quality !== 'lost' || req.c8;
    case 'phone_pattern':
      return quality !== 'lost';
    default:
      return true;
  }
}

const EPS = 1e-6;
export const LOG_CAP = 1024;
const EMPTY: readonly DmsAlertCommand[] = Object.freeze([]);

export function createAlertManager(cfg: DmsConfig, opts: { mode: 'live' | 'shadow' }) {
  const a = cfg.alerts;
  const muted = opts.mode === 'shadow';
  let nextId = 1;
  let critical: { kind: AlertKind; clearSince: number | null; lowSince: number | null; startT: number } | null = null;
  let distraction: AlertKind | null = null;
  const held: { req: AlertRequest; since: number; raised: Partial<AlertLogEntry> }[] = [];
  const lastTier1 = new Map<AlertKind, number>();
  const warnings = new RingBuffer<number>(16);
  const log = new RingBuffer<AlertLogEntry>(LOG_CAP);
  const byKind = Object.fromEntries(ALERT_KINDS.map((k) => [k, { delivered: 0, muted: 0, merged: 0, dropped: 0, suppressed: 0 }])) as Record<AlertKind, AlertCounts>;
  let invariantViolations = 0;
  /** a distraction/cumulative request since the last on-road frame or known-low run (T11 round 2) */
  let pendingEscalation = false;
  let pendingLowSince: number | null = null;
  /** the last cameraOff cause since the last camera frame (final review I2); null = none seen: a fault */
  let offCause: CameraOffCause | null = null;
  /** frames flowing since this time after a cameraOff; a second of them means the camera is back */
  let backSince: number | null = null;
  /** the last TRACKING frame (U-23, the lost cap) */
  let lastTrackingT = Number.NEGATIVE_INFINITY;

  function record(e: AlertLogEntry): void {
    log.push(e);
    byKind[e.kind][e.outcome]++;
  }
  function cmd(out: DmsAlertCommand[], x: { tMs: number; epochMs: number }, action: DmsAlertCommand['action'], kind: AlertKind): void {
    out.push({ id: nextId++, action, tier: tierOf(kind), kind, tMs: x.tMs, epochMs: x.epochMs, muted });
  }
  function deliver(out: DmsAlertCommand[], x: AlertFrame, req: AlertRequest, action: DmsAlertCommand['action'], extra: Partial<AlertLogEntry> = {}): void {
    cmd(out, x, action, req.kind);
    record({ kind: req.kind, tier: tierOf(req.kind), tMs: x.tMs, outcome: muted ? 'muted' : 'delivered', ...extra });
  }
  function refuse(x: { tMs: number }, req: AlertRequest, outcome: 'dropped' | 'suppressed', why: AlertLogEntry['why'], extra: Partial<AlertLogEntry> = {}): void {
    record({ kind: req.kind, tier: tierOf(req.kind), tMs: x.tMs, outcome, why, ...extra });
  }
  /** Where a request came from: its frame's quality and its C-8 flag. */
  const raisedOn = (req: AlertRequest, x: AlertFrame): Partial<AlertLogEntry> => ({ quality: x.quality, ...('c8' in req ? { c8: req.c8 } : {}) });
  const isEscalation = (req: AlertRequest) => req.kind === 'unresponsive' && req.escalation;
  /** A cap ends the running Critical, then one Tier 1 `monitoring_paused` says why (rule 3 applies; rule 4 does not). */
  function capCritical(out: DmsAlertCommand[], x: AlertFrame, why: 'blind_cap' | 'lost_cap', cause: PausedCause): void {
    const c = critical!;
    cmd(out, x, 'stop', c.kind);
    record({ kind: c.kind, tier: 3, tMs: x.tMs, outcome: 'dropped', why });
    critical = null;
    const last = lastTier1.get('monitoring_paused');
    if (last !== undefined && x.tMs - last < a.tier1EveryS * 1000 - EPS) {
      record({ kind: 'monitoring_paused', tier: 1, tMs: x.tMs, outcome: 'suppressed', why: 'tier1_rate' });
    } else {
      out.push({ id: nextId++, action: 'once', tier: 1, kind: 'monitoring_paused', tMs: x.tMs, epochMs: x.epochMs, muted, cause });
      record({ kind: 'monitoring_paused', tier: 1, tMs: x.tMs, outcome: muted ? 'muted' : 'delivered' });
      lastTier1.set('monitoring_paused', x.tMs);
    }
  }

  return {
    onFrame(x: AlertFrame): readonly DmsAlertCommand[] {
      if (x.blind !== true) {
        // A second of frames: the camera is back and the cause is spent. A stray in-flight frame right after
        // cameraOff keeps it (final review I2).
        if (offCause !== null) {
          backSince ??= x.tMs;
          if (x.tMs - backSince >= 1000 - EPS) offCause = null;
        }
        if (x.quality === 'tracking') lastTrackingT = x.tMs;
      } else backSince = null;
      // The escalation corroboration clears as D4's pending state does (no allocation).
      if (pendingEscalation) {
        const knownLow = x.speedKnown && x.ruleSpeedKmh !== null && x.ruleSpeedKmh < a.criticalEndBelowKmh;
        pendingLowSince = knownLow ? (pendingLowSince ?? x.tMs) : null;
        if (x.onRoad || (pendingLowSince !== null && x.tMs - pendingLowSince >= a.criticalEndAfterS * 1000 - EPS)) {
          pendingEscalation = false;
          pendingLowSince = null;
        }
      }
      // The fast path, most frames: nothing running, held or requested.
      if (critical === null && distraction === null && held.length === 0 && x.requests.length === 0) return EMPTY;
      const out: DmsAlertCommand[] = [];
      const audible = x.ruleSpeedKmh !== null && x.ruleSpeedKmh >= cfg.distraction.logOnlyBelowKmh - EPS;

      // Running states first: rule 1, rule 4, the Critical's end.
      if (distraction !== null && (x.onRoad || !audible)) {
        cmd(out, x, 'stop', distraction);
        distraction = null;
      }
      if (critical !== null) {
        const clear = x.eyesOpen && x.onRoad;
        // Final review m9: two clear instants across a gap are not a clear second.
        critical.clearSince = clear ? (x.gap === true ? x.tMs : (critical.clearSince ?? x.tMs)) : null;
        const knownLow = x.speedKnown && x.ruleSpeedKmh !== null && x.ruleSpeedKmh < a.criticalEndBelowKmh;
        critical.lowSince = knownLow ? (critical.lowSince ?? x.tMs) : null;
        const cleared = critical.clearSince !== null && x.tMs - critical.clearSince >= a.tier3ClearS * 1000 - EPS;
        const stopped = critical.lowSince !== null && x.tMs - critical.lowSince >= a.criticalEndAfterS * 1000 - EPS;
        if (cleared || stopped) {
          cmd(out, x, 'stop', critical.kind);
          critical = null;
        } else if (x.blind === true && x.blindSinceMs !== undefined && x.tMs - x.blindSinceMs >= a.criticalBlindMaxS * 1000 - EPS) {
          // Blind too long (no frame since blindSinceMs): stop, and tell the driver once why monitoring paused.
          capCritical(out, x, 'blind_cap', offCause ?? 'fault');
        } else if (x.tMs - Math.max(critical.startT, lastTrackingT) >= a.criticalLostMaxS * 1000 - EPS) {
          // U-23: no TRACKING face this long (LOST, HEAD_ONLY or blind): the clear condition is unobservable.
          capCritical(out, x, 'lost_cap', 'face_lost');
        }
      }

      // New requests. Round 3 nit: several Criticals on one frame (F1–F3 at a speed-gate lift) start only the
      // highest; the others are logged as merged, so the host never chirps three starts. The requests keep
      // their order (an accepted Critical earlier on the frame still verifies an escalation after it).
      const speedOk = (req: AlertRequest) => isEscalation(req) || (x.ruleSpeedKmh !== null && x.ruleSpeedKmh >= a.criticalMinStartKmh - EPS);
      const topRank = Math.max(0, ...x.requests.filter((r) => tierOf(r.kind) === 3 && speedOk(r)).map(rankOf));
      let criticalAcceptedNow = false;
      let criticalStartedNow = false;
      for (const req of x.requests) {
        const tier = tierOf(req.kind);
        const from = raisedOn(req, x);
        const r5 = rule5Holds(req, x.quality);
        if (DISTRACTION.has(req.kind)) {
          pendingEscalation = true;
          pendingLowSince = null;
        }
        if (tier === 3) {
          if (!speedOk(req)) {
            refuse(x, req, 'suppressed', 'speed', from);
            continue;
          }
          const unverified = isEscalation(req) && critical === null && !criticalAcceptedNow && !pendingEscalation;
          criticalAcceptedNow = true;
          if (!r5) invariantViolations++;
          if (unverified) invariantViolations++;
          const extra: Partial<AlertLogEntry> = { ...from, ...(!r5 ? { why: 'rule5_violation' } : unverified ? { why: 'escalation_unverified' } : {}) };
          if ((critical !== null && critical.kind === req.kind) || criticalStartedNow || rankOf(req) < topRank) {
            record({ kind: req.kind, tier, tMs: x.tMs, outcome: 'merged', ...extra });
            continue;
          }
          if (distraction !== null) {
            cmd(out, x, 'stop', distraction);
            distraction = null;
          }
          if (critical !== null) cmd(out, x, 'stop', critical.kind);
          critical = { kind: req.kind, clearSince: null, lowSince: null, startT: x.tMs };
          criticalStartedNow = true;
          deliver(out, x, req, 'start', extra);
          continue;
        }
        // Tier 1 and 2: rule 5, rule 6, then rule 4.
        if (!r5) {
          refuse(x, req, 'suppressed', 'rule5', from);
          continue;
        }
        if (x.warmup && req.kind !== 'distraction') {
          refuse(x, req, 'suppressed', 'warmup', from);
          continue;
        }
        if (!audible) {
          refuse(x, req, 'suppressed', 'speed', from);
          continue;
        }
        if (DISTRACTION.has(req.kind)) {
          if (critical !== null) {
            refuse(x, req, 'dropped', 'critical_running', from);
            continue;
          }
          if (distraction !== null) {
            record({ kind: req.kind, tier, tMs: x.tMs, outcome: 'merged', ...from });
            continue;
          }
          distraction = req.kind;
          deliver(out, x, req, 'start', from);
          // Rule 8: warnings the driver heard.
          warnings.push(x.tMs);
          warnings.dropWhile((t) => t <= x.tMs - a.repeatedGlancesWithinS * 1000);
          if (warnings.size >= a.repeatedGlancesCount) {
            warnings.clear();
            held.push({ req: { kind: 'repeated_glances' }, since: x.tMs, raised: { quality: x.quality } });
          }
          continue;
        }
        if (tier === 1) {
          const last = lastTier1.get(req.kind);
          if (last !== undefined && x.tMs - last < a.tier1EveryS * 1000 - EPS) {
            refuse(x, req, 'suppressed', 'tier1_rate', from);
            continue;
          }
        }
        held.push({ req, since: x.tMs, raised: from });
      }

      // Held bursts and Tier 1: at most one per frame once nothing louder runs; fatigue first.
      for (let i = held.length - 1; i >= 0; i--) {
        if (x.tMs - held[i]!.since > a.heldBackMaxS * 1000 + EPS) {
          refuse(x, held[i]!.req, 'dropped', 'held_too_long', held[i]!.raised);
          held.splice(i, 1);
        }
      }
      if (critical === null && distraction === null && held.length > 0) {
        let pick = held.findIndex((h) => h.req.kind === 'fatigue');
        if (pick < 0) pick = 0;
        const h = held[pick]!;
        held.splice(pick, 1);
        const last = lastTier1.get(h.req.kind);
        if (!audible || x.warmup) refuse(x, h.req, 'suppressed', audible ? 'warmup' : 'speed', h.raised);
        else if (tierOf(h.req.kind) === 1 && last !== undefined && x.tMs - last < a.tier1EveryS * 1000 - EPS) refuse(x, h.req, 'suppressed', 'tier1_rate', h.raised);
        else {
          if (tierOf(h.req.kind) === 1) lastTier1.set(h.req.kind, x.tMs);
          deliver(out, x, h.req, 'once', { ...h.raised, ...(h.req.kind === 'repeated_glances' ? { flag: true } : {}) });
        }
      }
      return out;
    },

    /**
     * The camera went off at speed (thermal L3, the low-light suspend; T13 r1 I1): a running distraction
     * stops (it could never see the road again), the held items are dropped, and a running Critical is
     * KEPT, bounded by criticalBlindMaxS without frames.
     */
    cameraOff(tMs: number, epochMs: number, cause: CameraOffCause): readonly DmsAlertCommand[] {
      const out: DmsAlertCommand[] = [];
      const x = { tMs, epochMs };
      if (distraction !== null) {
        cmd(out, x, 'stop', distraction);
        record({ kind: distraction, tier: 2, tMs, outcome: 'dropped', why: 'camera_off' });
        distraction = null;
      }
      for (const h of held) refuse(x, h.req, 'dropped', 'camera_off', h.raised);
      held.length = 0;
      offCause = cause;
      backSince = null;
      // Final review m5: the warning an escalation would belong to is gone.
      pendingEscalation = false;
      pendingLowSince = null;
      return out.length > 0 ? out : EMPTY;
    },

    /**
     * Ends the session's sound: `stop` for a running Critical or distraction, held items dropped
     * (`session_end`), state reset. For drive end, opt-out or revoke, sign-out and engine reset.
     */
    stopAll(tMs: number, epochMs: number): readonly DmsAlertCommand[] {
      // Final review m5: the warning an escalation would belong to was stopped.
      pendingEscalation = false;
      pendingLowSince = null;
      if (critical === null && distraction === null && held.length === 0) return EMPTY;
      const out: DmsAlertCommand[] = [];
      const x = { tMs, epochMs };
      if (distraction !== null) cmd(out, x, 'stop', distraction);
      if (critical !== null) cmd(out, x, 'stop', critical.kind);
      for (const h of held) refuse(x, h.req, 'dropped', 'session_end', h.raised);
      held.length = 0;
      distraction = null;
      critical = null;
      return out;
    },

    /** The invariant counter, read without copying anything (final review I4: snapshot() calls it per frame). */
    violations(): number {
      return invariantViolations;
    },

    /** The running Critical's kind, or null (the façade ends F3's no-on-road watch with it, Task 12). */
    critical(): AlertKind | null {
      return critical === null ? null : critical.kind;
    },

    /** Rule 7: tags the last logged alert; never changes live behaviour. */
    tagLastAlert(tag: 'wrong'): boolean {
      const last = log.last();
      if (last === undefined) return false;
      last.tag = tag;
      return true;
    },

    stats(): AlertStats {
      return {
        byKind: Object.fromEntries(ALERT_KINDS.map((k) => [k, { ...byKind[k] }])) as Record<AlertKind, AlertCounts>,
        log: log.toArray().map((e) => ({ ...e })),
        invariantViolations,
      };
    },
  };
}
