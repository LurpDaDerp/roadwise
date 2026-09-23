// Per-frame conditioning (plan §M1, §M2, §M6): smoothing within a quality run, the frames of reference,
// the gaze source per frame, per-eye openness with closure hysteresis, and the looking-down gate.
// Pure; the calibration it needs arrives as `ConditionerRefs` on every call.
import { relative, rollCorrect, toDriverFrame } from './angles';
import type { DmsConfig } from './config';
import { Median3 } from './filters';
import { geometricGaze } from './geometricGaze';
import { nearEye, type Quality, type QualityReason, type QualityResult } from './quality';
import type { AnglePair, DriverSide, EngineFrame, GazeSource, HeadAngles, Rotation } from './types';

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
  headCentre: AnglePair | null;
  openEyeEar: EarPair | null;
  /** the head-pitch reference for "looking down" before calibration (rev1 m6), driver frame */
  pitchReference: number | null;
}

export type GazeUse = 'gaze' | 'held' | 'head' | 'none';

export interface Perceived {
  tMs: number;
  /** since the previous frame, seconds (0 on the first) */
  dtS: number;
  quality: Quality;
  reasons: QualityReason[];
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
  /** zone widening this frame asks for (HEAD_ONLY and head fallback) */
  marginDeg: number;
  opennessR: number | null;
  opennessL: number | null;
  /** max over the used reliable eyes (the near eye alone past the yaw limit); null when unknown */
  openness: number | null;
  eyesClosed: boolean;
  /** how long the current closure has lasted, ms (0 when open) */
  closedMs: number;
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
  let lastNet: { net: AnglePair; head: AnglePair } | null = null;
  let closed = false;
  let closedSince = 0;
  let lastGazeRel: AnglePair | null = null;

  const resetSmoothing = () => {
    for (const m of [hy, hp, hr, gy, gp]) m.reset();
  };

  function openness(f: EngineFrame, q: QualityResult, ear: EarPair | null, headYaw: number): { r: number | null; l: number | null; used: number | null } {
    if (ear === null) return { r: null, l: null, used: null };
    const r = f.eyeR !== null && ear.r !== null && ear.r > 0 ? f.eyeR.ear / ear.r : null;
    const l = f.eyeL !== null && ear.l !== null && ear.l > 0 ? f.eyeL.ear / ear.l : null;
    const rr = q.reliableR ? r : null;
    const ll = q.reliableL ? l : null;
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
      prevHeadDrvYaw = null;
      lastNet = null;
      closed = false;
      lastGazeRel = null;
    },

    step(f, q, refs) {
      const dtS = prevT === null ? 0 : Math.max(0, (f.tMs - prevT) / 1000);
      prevT = f.tMs;
      if (q.quality !== lastQuality) resetSmoothing();
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

      // The net: this frame's, or the last corrected by the head change since (rev1 m11).
      let netCam: AnglePair | null = null;
      let netFresh = false;
      if (f.net !== null && headCam !== null) {
        netCam = f.net;
        netFresh = true;
        lastNet = { net: f.net, head: headCam };
      } else if (lastNet !== null && headCam !== null && q.quality !== 'lost') {
        netCam = { yaw: lastNet.net.yaw + (headCam.yaw - lastNet.head.yaw), pitch: lastNet.net.pitch + (headCam.pitch - lastNet.head.pitch) };
      }
      if (q.quality === 'lost') lastNet = null;

      const srcCam = refs.gazeSource === 'net' ? netCam : geoCam;
      const gazeDrv = srcCam === null ? null : toDrv(srcCam);
      const headRel = headDrv !== null && refs.headCentre !== null ? relative(headDrv, refs.headCentre) : null;

      // Openness and closure: TRACKING only; a quality drop ends the episode silently.
      let o = { r: null as number | null, l: null as number | null, used: null as number | null };
      if (q.quality === 'tracking' && f.head !== null) o = openness(f, q, refs.openEyeEar, f.head.yaw);
      if (o.used === null) {
        closed = false;
      } else if (!closed && o.used < cfg.closure.closedBelow) {
        closed = true;
        closedSince = f.tMs;
      } else if (closed && o.used > cfg.closure.openAbove) {
        closed = false;
      }
      const closedMs = closed ? f.tMs - closedSince : 0;

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
        } else if (gazeDrv !== null && refs.gazeCentre !== null) {
          source = 'gaze';
          gazeRel = relative(gazeDrv, refs.gazeCentre);
          lastGazeRel = gazeRel;
        } else headFallback();
      } else if (q.quality === 'head_only') {
        headFallback();
      }
      if (source !== 'gaze' && source !== 'held') lastGazeRel = source === 'none' ? null : lastGazeRel;

      // Looking down: the rules' relative pitch; before any centre, head pitch against the reference.
      const rel = gazeRel as AnglePair | null;
      let lookingDown = false;
      if (rel !== null) lookingDown = rel.pitch < cfg.closure.lookDownRelPitchDeg;
      else if (headDrv !== null && refs.pitchReference !== null) lookingDown = headDrv.pitch - refs.pitchReference < cfg.closure.lookDownRelPitchDeg;

      return {
        tMs: f.tMs,
        dtS,
        quality: q.quality,
        reasons: q.reasons,
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
        marginDeg,
        opennessR: o.r,
        opennessL: o.l,
        openness: o.used,
        eyesClosed: closed,
        closedMs,
        lookingDown,
        headYawSpeedDegS,
      };
    },
  };
}
