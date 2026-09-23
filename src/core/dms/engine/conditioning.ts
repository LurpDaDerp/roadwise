// Per-frame conditioning (plan §M1, §M2, §M6): smoothing within a quality run, the frames of reference,
// the gaze source per frame, per-eye openness with closure hysteresis, and the looking-down gate.
// Pure; the calibration it needs arrives as `ConditionerRefs` on every call.
import { relative, rollCorrect, toDriverFrame } from './angles';
import type { DmsConfig } from './config';
import { Median3 } from './filters';
import { geometricGaze } from './geometricGaze';
import { nearEye, type Quality, type QualityReason, type QualityResult } from './quality';
import type { AnglePair, DriverSide, EngineFrame, GazeSource, HeadAngles, Rotation } from './types';
import { RingBuffer } from './windows';

export interface EarPair {
  r: number | null;
  l: number | null;
}

/** What the conditioner needs from calibration, read on every frame. */
export interface ConditionerRefs {
  driverSide: DriverSide;
  gazeSource: GazeSource;
  rollOffsetDeg: number;
  /** the configured source's road centre (driver frame); null before any */
  gazeCentre: AnglePair | null;
  /**
   * the geometric path's road centre, for a net configuration's fallback: with no net value on the frame (the
   * policy turned the net off, or this build has none), the geometric gaze is used against its own centre
   * (plan Task 15, the cross-seam table). Optional: absent means no fallback.
   */
  geoCentre?: AnglePair | null;
  headCentre: AnglePair | null;
  openEyeEar: EarPair | null;
  /** the head-pitch reference for "looking down" before calibration (rev1 m6), driver frame */
  pitchReference: number | null;
  /** the policy's gazeNetEvery (1 or 2): how long a net value may be carried (T6 review m2); default 1 */
  gazeNetEvery?: number;
}

export type GazeUse = 'gaze' | 'held' | 'head' | 'none';

export interface Perceived {
  tMs: number;
  /** since the previous frame, seconds (0 on the first) */
  dtS: number;
  /**
   * T12 review I1: more than closure.maxFrameGapS since the previous frame. The time between was not
   * observed: consumers count 0 for this frame's dt, an unbridged closure ended at the gap (a new one may
   * start on this frame), and the smoothing restarted. An active C-26 bridge continues.
   */
  gap: boolean;
  quality: Quality;
  reasons: QualityReason[];
  /** usable for openness (T6 review C1) */
  usableR: boolean;
  usableL: boolean;
  /** reliable for the geometric gaze */
  reliableR: boolean;
  reliableL: boolean;
  rotationDeg: Rotation;
  /** smoothed, camera frame */
  headCam: HeadAngles | null;
  /** the geometric gaze, smoothed, camera frame; null without a usable eye */
  geoCam: AnglePair | null;
  /** the net's gaze, camera frame: this frame's (netFresh) or the last one corrected by the head change */
  netCam: AnglePair | null;
  netFresh: boolean;
  /** roll-corrected driver frame, not centred */
  headDrv: AnglePair | null;
  /** the configured source, roll-corrected driver frame, not centred */
  gazeDrv: AnglePair | null;
  headRel: AnglePair | null;
  /** what the rules use: relative to the source's centre (gaze / held), or the head's (head) */
  gazeRel: AnglePair | null;
  source: GazeUse;
  /** which path gave a `gaze` source this frame; null for held, head or none */
  gazeFrom: 'net' | 'geometric' | null;
  /** zone widening this frame asks for (HEAD_ONLY and head fallback) */
  marginDeg: number;
  opennessR: number | null;
  opennessL: number | null;
  /** max over the used reliable eyes (the near eye alone past the yaw limit); null when unknown */
  openness: number | null;
  eyesClosed: boolean;
  /** how long the current closure has lasted, ms (0 when open); it keeps running through a bridge */
  closedMs: number;
  /**
   * C-26: this non-TRACKING frame carries a closure across a face loss (eyes shut ≥ 500 ms, then the
   * head went down and the face was lost, not a turn). `eyesClosed` stays true. PERCLOS must not count
   * bridged time as TRACKING time.
   */
  closureBridged: boolean;
  lookingDown: boolean;
  /** driver-frame head yaw rate, °/s; null without two consecutive heads */
  headYawSpeedDegS: number | null;
}

export interface Conditioner {
  step(f: EngineFrame, q: QualityResult, refs: ConditionerRefs): Perceived;
  reset(): void;
}

export function createConditioner(cfg: DmsConfig): Conditioner {
  const hy = new Median3();
  const hp = new Median3();
  const hr = new Median3();
  const gy = new Median3();
  const gp = new Median3();
  let lastQuality: Quality | null = null;
  let prevT: number | null = null;
  let prevHeadDrvYaw: number | null = null;
  let prevHeadT = 0;
  let lastNet: { net: AnglePair; head: AnglePair; t: number } | null = null;
  let frameIntervalMs = 1000 / 15;
  let closed = false;
  let closedSince = 0;
  // C-26 closure bridging: the evidence at the loss, and the bridge itself.
  let lastTrackedClosedMs = 0;
  let bridged = false;
  let bridgeStart = 0;
  const pitchHist = new RingBuffer<{ t: number; v: number }>(64);
  const yawSpeeds = new RingBuffer<{ t: number; v: number }>(32);
  let lastRelYaw: number | null = null;
  // Iris evidence in time, per eye (T6 round-1 review R1-I1).
  const lastReliableT = { r: Number.NEGATIVE_INFINITY, l: Number.NEGATIVE_INFINITY };
  const episode = { r: false, l: false };
  let lastGazeRel: AnglePair | null = null;

  const resetSmoothing = () => {
    for (const m of [hy, hp, hr, gy, gp]) m.reset();
  };

  /**
   * The quality the rules see: an eye counts as usable for openness only if it is usable in this frame
   * AND its iris was seen (reliable) within irisRecencyS, or it is inside a closure episode that began
   * while it counted (F2/F3 and a sleeping driver stay visible past the window). The episode ends when
   * the eye reopens (> openAbove) or becomes unusable, except during a C-26 bridge, when it ends only on
   * reopening or the bridge's silent end (step, after the closure update). TRACKING needs one such eye;
   * a drive that starts in sunglasses is HEAD_ONLY until an iris is seen.
   */
  function eyeTiers(f: EngineFrame, q: QualityResult): QualityResult {
    const within = cfg.quality.irisRecencyS * 1000;
    if (q.reliableR) lastReliableT.r = f.tMs;
    if (q.reliableL) lastReliableT.l = f.tMs;
    const usableR = q.usableR && (f.tMs - lastReliableT.r <= within || episode.r);
    const usableL = q.usableL && (f.tMs - lastReliableT.l <= within || episode.l);
    if (q.quality !== 'tracking' || usableR || usableL) return { ...q, usableR, usableL };
    return { ...q, quality: 'head_only', reasons: [...q.reasons, 'eyes_unreliable'], usableR, usableL };
  }

  function openness(f: EngineFrame, q: QualityResult, ear: EarPair | null, headYaw: number): { r: number | null; l: number | null; used: number | null } {
    if (ear === null) return { r: null, l: null, used: null };
    const r = f.eyeR !== null && ear.r !== null && ear.r > 0 ? f.eyeR.ear / ear.r : null;
    const l = f.eyeL !== null && ear.l !== null && ear.l > 0 ? f.eyeL.ear / ear.l : null;
    const rr = q.usableR ? r : null;
    const ll = q.usableL ? l : null;
    let used: number | null;
    if (Math.abs(headYaw) > cfg.closure.nearEyeYawDeg) {
      const near = nearEye(f);
      used = near === 'r' ? rr : near === 'l' ? ll : null;
    } else {
      used = rr === null ? ll : ll === null ? rr : Math.max(rr, ll);
    }
    return { r, l, used };
  }

  return {
    reset() {
      resetSmoothing();
      lastQuality = null;
      prevT = null;
      lastReliableT.r = Number.NEGATIVE_INFINITY;
      lastReliableT.l = Number.NEGATIVE_INFINITY;
      episode.r = false;
      episode.l = false;
      prevHeadDrvYaw = null;
      lastNet = null;
      closed = false;
      bridged = false;
      lastTrackedClosedMs = 0;
      pitchHist.clear();
      yawSpeeds.clear();
      lastRelYaw = null;
      lastGazeRel = null;
    },

    step(f, raw, refs) {
      const q = eyeTiers(f, raw);
      const dtS = prevT === null ? 0 : Math.max(0, (f.tMs - prevT) / 1000);
      const gap = dtS > cfg.closure.maxFrameGapS;
      if (dtS > 0 && !gap) frameIntervalMs = dtS * 1000;
      prevT = f.tMs;
      if (q.quality !== lastQuality || gap) resetSmoothing();
      if (gap) {
        // Unobserved time: an unbridged closure ends silently, and no gaze is held across it.
        if (!bridged) closed = false;
        lastGazeRel = null;
      }
      lastQuality = q.quality;

      const toDrv = (a: AnglePair) => toDriverFrame(rollCorrect(a, refs.rollOffsetDeg), refs.driverSide);

      // Head: smoothed within the quality run.
      let headCam: HeadAngles | null = null;
      if (f.head !== null && q.quality !== 'lost') {
        headCam = { yaw: hy.push(f.head.yaw), pitch: hp.push(f.head.pitch), roll: hr.push(f.head.roll) };
      }
      const headDrv = headCam === null ? null : toDrv(headCam);
      let headYawSpeedDegS: number | null = null;
      if (headDrv !== null) {
        if (prevHeadDrvYaw !== null && f.tMs > prevHeadT) headYawSpeedDegS = ((headDrv.yaw - prevHeadDrvYaw) * 1000) / (f.tMs - prevHeadT);
        prevHeadDrvYaw = headDrv.yaw;
        prevHeadT = f.tMs;
      } else {
        prevHeadDrvYaw = null;
      }

      // The geometric gaze (camera frame), smoothed.
      let geoCam: AnglePair | null = null;
      if (q.quality === 'tracking' && f.head !== null) {
        const g = geometricGaze(f.head, f, { r: q.reliableR, l: q.reliableL }, cfg);
        if (g !== null) geoCam = { yaw: gy.push(g.yaw), pitch: gp.push(g.pitch) };
      }
      if (geoCam === null) {
        // A dropout of the geometric gaze starts a new smoothing run (T6 review m4).
        gy.reset();
        gp.reset();
      }

      // The net: this frame's, or the last corrected by the head change since (rev1 m11).
      let netCam: AnglePair | null = null;
      let netFresh = false;
      // It expires after max(300 ms, 2 × gazeNetEvery frame intervals) (T6 review m2): then the frame
      // takes the head fallback with its margin.
      const netHoldMs = Math.max(cfg.gaze.netHoldMinMs, 2 * (refs.gazeNetEvery ?? 1) * frameIntervalMs);
      if (f.net !== null && headCam !== null) {
        netCam = f.net;
        netFresh = true;
        lastNet = { net: f.net, head: headCam, t: f.tMs };
      } else if (lastNet !== null && headCam !== null && q.quality !== 'lost' && f.tMs - lastNet.t <= netHoldMs + 1e-6) {
        netCam = { yaw: lastNet.net.yaw + (headCam.yaw - lastNet.head.yaw), pitch: lastNet.net.pitch + (headCam.pitch - lastNet.head.pitch) };
      }
      if (q.quality === 'lost') lastNet = null;

      // The configured source; a net configuration with no net value falls back to the geometric path, measured
      // against the geometric centre (never the net's), so the net is used only when it ran.
      const netFallback = refs.gazeSource === 'net' && netCam === null && geoCam !== null && (refs.geoCentre ?? null) !== null;
      const srcCam = refs.gazeSource === 'net' ? (netCam ?? (netFallback ? geoCam : null)) : geoCam;
      const srcCentre = netFallback ? refs.geoCentre! : refs.gazeCentre;
      const gazeFromSrc: 'net' | 'geometric' = refs.gazeSource === 'net' && !netFallback ? 'net' : 'geometric';
      const gazeDrv = srcCam === null ? null : toDrv(srcCam);
      const headRel = headDrv !== null && refs.headCentre !== null ? relative(headDrv, refs.headCentre) : null;

      // The head evidence C-26 needs: relative pitch (to the head centre, or the pre-calibration
      // reference), its last second, and the C-8 turn signals (yaw speed in the fast-turn window, yaw).
      const cl = cfg.closure;
      const relPitch = headDrv === null ? null : refs.headCentre !== null ? headDrv.pitch - refs.headCentre.pitch : refs.pitchReference !== null ? headDrv.pitch - refs.pitchReference : null;
      if (relPitch !== null) pitchHist.push({ t: f.tMs, v: relPitch });
      pitchHist.dropWhile((s) => s.t < f.tMs - cl.bridgeDropWindowS * 1000);
      if (headYawSpeedDegS !== null) yawSpeeds.push({ t: f.tMs, v: headYawSpeedDegS });
      yawSpeeds.dropWhile((s) => s.t < f.tMs - cfg.zones.fastTurnWindowMs);
      if (headRel !== null) lastRelYaw = headRel.yaw;
      const headDown = (v: number | null) => v !== null && v <= -cfg.nod.referenceWithinDeg;
      const turnNow = headYawSpeedDegS !== null && Math.abs(headYawSpeedDegS) > cfg.zones.fastTurnDegS;
      const yawFar = (y: number | null) => y !== null && Math.abs(y) > cfg.zones.lostLateralYawDeg;

      // Openness and closure. TRACKING measures it; a loss ends it silently unless C-26 bridges it.
      let o = { r: null as number | null, l: null as number | null, used: null as number | null };
      if (q.quality === 'tracking' && f.head !== null) o = openness(f, q, refs.openEyeEar, f.head.yaw);
      let bridgeEnded = false;
      if (o.used !== null) {
        bridged = false; // back in TRACKING: a closed eye continues the same closure, an open one ends it
        if (!closed && o.used < cl.closedBelow) {
          closed = true;
          closedSince = f.tMs;
        } else if (closed && o.used > cl.openAbove) {
          closed = false;
        }
        lastTrackedClosedMs = closed ? f.tMs - closedSince : 0;
      } else if (q.quality === 'tracking') {
        // TRACKING without an openness (e.g. past 25° yaw with the near eye unusable) ends the closure
        // silently, as before C-26: a bridge starts and holds only on HEAD_ONLY/LOST frames (T9 r1 nit).
        if (bridged) bridgeEnded = true;
        else closed = false;
      } else if (bridged) {
        // Keep: every LOST frame; a HEAD_ONLY frame only with the head still down and no turn evidence.
        const capped = f.tMs - bridgeStart > cl.bridgeMaxS * 1000 + 1e-6;
        const keep = q.quality === 'lost' || (headDown(relPitch) && !turnNow && !yawFar(headRel?.yaw ?? null) && !q.reasons.includes('head_yaw'));
        if (capped || !keep) bridgeEnded = true;
      } else if (closed) {
        // Start: the closure was longer than a blink, the head was going down, and it is not a C-8 turn.
        const last = pitchHist.last();
        let peak = Number.NEGATIVE_INFINITY;
        pitchHist.forEach((s) => (peak = Math.max(peak, s.v)));
        const dropped = last !== undefined && (headDown(last.v) || peak - last.v >= cl.bridgeHeadDropDeg - 1e-9);
        let turnPeak = 0;
        yawSpeeds.forEach((s) => (turnPeak = Math.max(turnPeak, Math.abs(s.v))));
        const turn = turnPeak > cfg.zones.fastTurnDegS || yawFar(lastRelYaw) || q.reasons.includes('head_yaw');
        if (lastTrackedClosedMs >= cl.bridgeMinClosedMs - 1e-6 && dropped && !turn) {
          bridged = true;
          bridgeStart = f.tMs;
        } else closed = false;
      }
      if (bridgeEnded) {
        // A silent end (a turn, the head back up, the cap): no closure, and the per-eye episodes end.
        bridged = false;
        closed = false;
        episode.r = false;
        episode.l = false;
      }
      const closedMs = closed ? f.tMs - closedSince : 0;
      // A closure episode per eye starts only while the eye counts, and ends when it reopens or becomes
      // unusable (except during a bridge).
      for (const [side, o1, usable] of [['r', o.r, q.usableR], ['l', o.l, q.usableL]] as const) {
        if (!usable || o1 === null) {
          if (!usable && !bridged) episode[side] = false;
          continue;
        }
        if (o1 < cfg.closure.closedBelow) episode[side] = true;
        else if (o1 > cfg.closure.openAbove) episode[side] = false;
      }

      // The gaze the rules use (§M2).
      let source: GazeUse = 'none';
      let gazeRel: AnglePair | null = null;
      let marginDeg = 0;
      const headFallback = () => {
        source = headRel === null ? 'none' : 'head';
        gazeRel = headRel;
        marginDeg = headRel === null ? 0 : cfg.gaze.headOnlyMarginDeg;
      };
      if (q.quality === 'tracking') {
        if (closed) {
          if (closedMs < cfg.gaze.blinkHoldMs && lastGazeRel !== null) {
            source = 'held';
            gazeRel = lastGazeRel;
          } else headFallback();
        } else if (gazeDrv !== null && srcCentre !== null) {
          source = 'gaze';
          gazeRel = relative(gazeDrv, srcCentre);
          lastGazeRel = gazeRel;
        } else headFallback();
      } else if (q.quality === 'head_only') {
        headFallback();
      }
      // Only a gaze seen this closure's run may be held (T6 review m4).
      if (source !== 'gaze' && source !== 'held') lastGazeRel = null;

      // Looking down: the rules' relative pitch; before any centre, head pitch against the reference.
      const rel = gazeRel as AnglePair | null;
      let lookingDown = false;
      if (rel !== null) lookingDown = rel.pitch < cfg.closure.lookDownRelPitchDeg;
      else if (headDrv !== null && refs.pitchReference !== null) lookingDown = headDrv.pitch - refs.pitchReference < cfg.closure.lookDownRelPitchDeg;

      return {
        tMs: f.tMs,
        dtS,
        gap,
        quality: q.quality,
        reasons: q.reasons,
        usableR: q.usableR,
        usableL: q.usableL,
        reliableR: q.reliableR,
        reliableL: q.reliableL,
        rotationDeg: f.rotationDeg,
        headCam,
        geoCam,
        netCam,
        netFresh,
        headDrv,
        gazeDrv,
        headRel,
        gazeRel,
        source,
        gazeFrom: source === 'gaze' ? gazeFromSrc : null,
        marginDeg,
        opennessR: o.r,
        opennessL: o.l,
        openness: o.used,
        eyesClosed: closed,
        closedMs,
        closureBridged: bridged,
        lookingDown,
        headYawSpeedDegS,
      };
    },
  };
}
