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
//  4. Nothing audible below 20 km/h (Tier 1 and 2; a running distraction stops). A Critical may START at
//     ≥ 10 km/h, continues through a slowdown and through LOST, and ends on its stop condition (the eyes
//     open AND on road for tier3ClearS) or after a KNOWN speed < 10 km/h held criticalEndAfterS. An
//     unknown, held or inferred speed never ends it (rev1 I6; T8 review m4: `speedKnown`).
//  5. No distraction alert from a LOST frame except C-8 (`c8`); no closure Critical from HEAD_ONLY or
//     LOST except a C-26 bridge (`bridged`). The rules already hold this; the manager checks it again.
//  6. Warm-up: only Critical and D1 (`distraction`).
//  7. tagLastAlert('wrong') tags the last logged alert and never changes live behaviour.
//  8. Three Tier 2 distraction warnings within 10 min → one Tier 1 `repeated_glances` with an event
//     flag, instead of any louder tier; the count then restarts.
//  9. Sensitivity (C-20) scales D1's buffer in attention.ts.
// Shadow mode decides everything the same and marks every command `muted`.
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
  | 'repeated_glances';

export const ALERT_KINDS: readonly AlertKind[] = ['distraction', 'cumulative', 'phone_pattern', 'unresponsive', 'microsleep', 'microsleep_nod', 'sleep', 'fatigue_early', 'fatigue', 'repeated_glances'];

export interface DmsAlertCommand {
  id: number;
  action: 'start' | 'stop' | 'once';
  tier: 1 | 2 | 3;
  kind: AlertKind;
  tMs: number;
  epochMs: number;
  muted: boolean;
}

export interface AlertRequest {
  kind: AlertKind;
  /** a closure rule (F1–F3, microsleep_nod): rule 5 needs TRACKING or a C-26 bridge */
  closure?: boolean;
  /** raised through a C-26 closure bridge */
  bridged?: boolean;
  /** raised on a C-8 far-lateral (turn-into-LOST) frame */
  c8?: boolean;
}

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
  requests: AlertRequest[];
}

export type AlertOutcome = 'delivered' | 'muted' | 'merged' | 'dropped' | 'suppressed';

export interface AlertLogEntry {
  kind: AlertKind;
  tier: 1 | 2 | 3;
  tMs: number;
  outcome: AlertOutcome;
  /** why it was suppressed or dropped */
  why?: 'speed' | 'warmup' | 'rule5' | 'tier1_rate' | 'held_too_long' | 'critical_running';
  /** rule 8's event flag */
  flag?: boolean;
  /** rule 7 */
  tag?: 'wrong';
}

export type AlertCounts = Record<AlertOutcome, number>;

const CRITICAL: ReadonlySet<AlertKind> = new Set(['unresponsive', 'microsleep', 'microsleep_nod', 'sleep']);
const DISTRACTION: ReadonlySet<AlertKind> = new Set(['distraction', 'cumulative']);

export function tierOf(kind: AlertKind): 1 | 2 | 3 {
  if (CRITICAL.has(kind)) return 3;
  if (DISTRACTION.has(kind) || kind === 'fatigue') return 2;
  return 1;
}

const EPS = 1e-6;
const LOG_CAP = 1024;

export function createAlertManager(cfg: DmsConfig, opts: { mode: 'live' | 'shadow' }) {
  const a = cfg.alerts;
  const muted = opts.mode === 'shadow';
  let nextId = 1;
  let critical: { kind: AlertKind; clearSince: number | null; lowSince: number | null } | null = null;
  let distraction: AlertKind | null = null;
  const held: { req: AlertRequest; since: number }[] = [];
  const lastTier1 = new Map<AlertKind, number>();
  const warnings = new RingBuffer<number>(16);
  const log = new RingBuffer<AlertLogEntry>(LOG_CAP);
  const byKind = Object.fromEntries(ALERT_KINDS.map((k) => [k, { delivered: 0, muted: 0, merged: 0, dropped: 0, suppressed: 0 }])) as Record<AlertKind, AlertCounts>;

  function record(e: AlertLogEntry): void {
    log.push(e);
    byKind[e.kind][e.outcome]++;
  }

  return {
    onFrame(x: AlertFrame): DmsAlertCommand[] {
      const out: DmsAlertCommand[] = [];
      const cmd = (action: DmsAlertCommand['action'], kind: AlertKind) =>
        out.push({ id: nextId++, action, tier: tierOf(kind), kind, tMs: x.tMs, epochMs: x.epochMs, muted });
      const deliver = (req: AlertRequest, action: DmsAlertCommand['action'], extra: Partial<AlertLogEntry> = {}) => {
        cmd(action, req.kind);
        record({ kind: req.kind, tier: tierOf(req.kind), tMs: x.tMs, outcome: muted ? 'muted' : 'delivered', ...extra });
      };
      const refuse = (req: AlertRequest, outcome: 'dropped' | 'suppressed', why: AlertLogEntry['why']) =>
        record({ kind: req.kind, tier: tierOf(req.kind), tMs: x.tMs, outcome, why });
      const audible = x.ruleSpeedKmh !== null && x.ruleSpeedKmh >= cfg.distraction.logOnlyBelowKmh - EPS;

      // Running states first: rule 1, rule 4, the Critical's end.
      if (distraction !== null && (x.onRoad || !audible)) {
        cmd('stop', distraction);
        distraction = null;
      }
      if (critical !== null) {
        const clear = x.eyesOpen && x.onRoad;
        critical.clearSince = clear ? (critical.clearSince ?? x.tMs) : null;
        const knownLow = x.speedKnown && x.ruleSpeedKmh !== null && x.ruleSpeedKmh < a.criticalEndBelowKmh;
        critical.lowSince = knownLow ? (critical.lowSince ?? x.tMs) : null;
        const cleared = critical.clearSince !== null && x.tMs - critical.clearSince >= a.tier3ClearS * 1000 - EPS;
        const stopped = critical.lowSince !== null && x.tMs - critical.lowSince >= a.criticalEndAfterS * 1000 - EPS;
        if (cleared || stopped) {
          cmd('stop', critical.kind);
          critical = null;
        }
      }

      // New requests.
      for (const req of x.requests) {
        const tier = tierOf(req.kind);
        // Rule 5 (checked again here).
        if (req.closure === true && x.quality !== 'tracking' && req.bridged !== true) {
          refuse(req, 'suppressed', 'rule5');
          continue;
        }
        if (!req.closure && x.quality === 'lost' && req.c8 !== true && (DISTRACTION.has(req.kind) || req.kind === 'phone_pattern' || req.kind === 'unresponsive')) {
          refuse(req, 'suppressed', 'rule5');
          continue;
        }
        if (tier === 3) {
          if (x.ruleSpeedKmh === null || x.ruleSpeedKmh < a.criticalMinStartKmh - EPS) {
            refuse(req, 'suppressed', 'speed');
            continue;
          }
          if (critical !== null && critical.kind === req.kind) {
            record({ kind: req.kind, tier, tMs: x.tMs, outcome: 'merged' });
            continue;
          }
          if (distraction !== null) {
            cmd('stop', distraction);
            distraction = null;
          }
          if (critical !== null) cmd('stop', critical.kind);
          critical = { kind: req.kind, clearSince: null, lowSince: null };
          deliver(req, 'start');
          continue;
        }
        // Tier 1 and 2: rule 6, then rule 4.
        if (x.warmup && req.kind !== 'distraction') {
          refuse(req, 'suppressed', 'warmup');
          continue;
        }
        if (!audible) {
          refuse(req, 'suppressed', 'speed');
          continue;
        }
        if (DISTRACTION.has(req.kind)) {
          if (critical !== null) {
            refuse(req, 'dropped', 'critical_running');
            continue;
          }
          if (distraction !== null) record({ kind: req.kind, tier, tMs: x.tMs, outcome: 'merged' });
          else {
            distraction = req.kind;
            deliver(req, 'start');
          }
          // Rule 8.
          warnings.push(x.tMs);
          warnings.dropWhile((t) => t <= x.tMs - a.repeatedGlancesWithinS * 1000);
          if (warnings.size >= a.repeatedGlancesCount) {
            warnings.clear();
            held.push({ req: { kind: 'repeated_glances' }, since: x.tMs });
          }
          continue;
        }
        if (tier === 1) {
          const last = lastTier1.get(req.kind);
          if (last !== undefined && x.tMs - last < a.tier1EveryS * 1000 - EPS) {
            refuse(req, 'suppressed', 'tier1_rate');
            continue;
          }
        }
        held.push({ req, since: x.tMs });
      }

      // Held bursts and Tier 1: at most one per frame once nothing louder runs; fatigue first.
      for (let i = held.length - 1; i >= 0; i--) {
        if (x.tMs - held[i]!.since > a.heldBackMaxS * 1000 + EPS) {
          refuse(held[i]!.req, 'dropped', 'held_too_long');
          held.splice(i, 1);
        }
      }
      if (critical === null && distraction === null && held.length > 0) {
        let pick = held.findIndex((h) => h.req.kind === 'fatigue');
        if (pick < 0) pick = 0;
        const h = held[pick]!;
        held.splice(pick, 1);
        if (!audible || (x.warmup && h.req.kind !== 'distraction')) refuse(h.req, 'suppressed', audible ? 'warmup' : 'speed');
        else if (tierOf(h.req.kind) === 1 && lastTier1.has(h.req.kind) && x.tMs - lastTier1.get(h.req.kind)! < a.tier1EveryS * 1000 - EPS) refuse(h.req, 'suppressed', 'tier1_rate');
        else {
          if (tierOf(h.req.kind) === 1) lastTier1.set(h.req.kind, x.tMs);
          deliver(h.req, 'once', h.req.kind === 'repeated_glances' ? { flag: true } : {});
        }
      }
      return out;
    },

    /** Rule 7: tags the last logged alert; never changes live behaviour. */
    tagLastAlert(tag: 'wrong'): boolean {
      const last = log.last();
      if (last === undefined) return false;
      last.tag = tag;
      return true;
    },

    stats(): { byKind: Record<AlertKind, AlertCounts>; log: AlertLogEntry[] } {
      return { byKind: Object.fromEntries(ALERT_KINDS.map((k) => [k, { ...byKind[k] }])) as Record<AlertKind, AlertCounts>, log: log.toArray().map((e) => ({ ...e })) };
    },
  };
}
