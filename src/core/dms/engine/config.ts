// Every DMS engine number, once (plan §M: "All numbers live once in config.ts"). Each value cites
// where it comes from: "spec <section>" is the DMS design spec, "§Mn" the plan's binding model, and a
// C-/rev tag the plan's ruling that changed it. The wire, frame-rate and thermal numbers live in
// modules/dms-vision/src/constants.ts; PAUSE_AFTER_STOP_MS is re-exported from there, never copied.
//
// Units are in the names: S seconds, Ms milliseconds, Deg degrees, Kmh km/h, DegS °/s. Durations are
// on the frame clock.
//
// Validation (validateDmsConfig) is total: every number finite, durations and sizes ≥ 0 unless the
// path is a signed angle, fractions in [0, 1], ranges ordered, the fatigue weights summing to 1, the
// zone table complete. configFromJson checks the shape key by key against the default, then validates.
import { ALLOWED_FPS, PAUSE_AFTER_STOP_MS } from '../../../../modules/dms-vision/src/constants';
import type { GazeSource, Sensitivity } from './types';

export { PAUSE_AFTER_STOP_MS };

/** Zones in priority order (§M4 table rows 1–11). */
export const ZONE_IDS = [
  'road_centre',
  'phone_screen',
  'rear_mirror',
  'forward_road',
  'driver_mirror',
  'passenger_mirror',
  'cluster',
  'lap',
  'centre_stack',
  'far_lateral',
  'other',
] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export type ZoneClass = 'on_road' | 'driving' | 'non_driving';

/** Regions in the driver frame, relative to the road centre (degrees). */
export type ZoneRegion =
  /** the calibrated road-centre circle (radius from §M3) */
  | { kind: 'centre' }
  /** a circle around the camera's own direction in the driver frame */
  | { kind: 'camera'; radiusDeg: number }
  | { kind: 'rect'; yaw: [number, number]; pitch: [number, number] }
  /** pitch ≤ maxPitchDeg and |yaw| ≤ maxAbsYawDeg */
  | { kind: 'below'; maxPitchDeg: number; maxAbsYawDeg: number }
  /** |yaw| > minAbsYawDeg (or LOST after a fast turn, C-8) */
  | { kind: 'lateral'; minAbsYawDeg: number }
  | { kind: 'rest' };

export interface ZoneSpec {
  id: ZoneId;
  region: ZoneRegion;
  class: ZoneClass;
  /** seconds off-road before D1 drains (non-on-road zones) */
  graceS: number;
  /** D1 drain weight (on-road zones refill; their weight is 0) */
  weight: number;
  /** the grace when the glance is a shoulder check (far lateral only) */
  shoulderCheckGraceS: number | null;
  /** a mirror whose region may be replaced by a learned cluster (§M4 zone learning) */
  learnable: boolean;
}

export interface FatigueSignal {
  windowS: number;
  /** the sub-score reaches 1 at the target */
  target: number;
  /** e = max(target, baseline + margin); null for a signal scored by its reduction (dispersion) */
  margin: number | null;
  weight: number;
  /** dropped (weight renormalised) below this measured fps; 0 = never dropped */
  minFps: number;
}

export interface DmsConfig {
  v: 1;
  /** plan C-24, rev1 R-gaze: the geometric gaze everywhere by default; 'net' only in internal builds */
  gazeSource: GazeSource;
  /**
   * T14 r1 nit (rev1 m11): the net on every frame (1) or every other frame (2) in FULL. Default 2: the T6 m2
   * hold carries a net value across the skipped frame, at half the net's cost. Only a net build uses it.
   */
  gazeNetEvery: 1 | 2;

  context: {
    /** §M1: a context row older than this is stale (speed unknown); must exceed rowTickMs */
    rowStaleMs: number;
    /** final review m7: the 1 Hz row period; a row with no frame this long before it is a blind tick */
    rowTickMs: number;
    /** rev1 I6: unknown speed keeps the last known class this long while the IMU shows motion */
    tunnelHoldMs: number;
    /** rev1 I6: unknown speed without IMU motion keeps the class this long, then counts as < 10 km/h */
    unknownStillHoldMs: number;
    /** §M1: the course rate needs a valid fix at ≥ this speed on both rows (m/s) */
    courseMinSpeedMs: number;
    /** §M4 junction: the turn sign is set above this course rate (°/s) */
    turnSignMinDegS: number;
    /** plan "Capture states" SEARCH: phone handling is handlingScore ≥ this */
    handlingMinScore: number;
  };

  quality: {
    /** §M2 LOST: box area below this */
    lostMinBoxArea: number;
    /** §M2 LOST: face luma below this */
    lostMaxFaceLuma: number;
    /** §M2: no face and frame luma below this → reason low_light */
    lowLightFrameLuma: number;
    /** §M2 eye unreliable (rev2 R1-I1, the single definition): eye luma ratio below this */
    eyeMinLuma: number;
    /** …iris contrast below this */
    eyeMinIrisContrast: number;
    /** …saturated share above this (glare) */
    eyeMaxSat: number;
    /** …eye width below this, px */
    eyeMinWidthPx: number;
    /** §M2 HEAD_ONLY: |head yaw| (camera) above this; spec "Quality states" ±40° */
    headOnlyYawDeg: number;
    /** §M2 HEAD_ONLY: blur below this */
    headOnlyMinBlur: number;
    /** §M2 HEAD_ONLY: face luma below this */
    headOnlyMinFaceLuma: number;
    /** §M2, C-7: "monitoring limited" after this long LOST/low-light HEAD_ONLY (visual only) */
    limitedNoticeS: number;
    /** …at or above this speed */
    limitedMinSpeedKmh: number;
    /**
     * T6 round-1 review R1-I1: an eye counts for openness only if its iris was seen (reliable) within
     * this long, or it is inside a closure that began while it counted. A lens never shows an iris.
     */
    irisRecencyS: number;
  };

  gaze: {
    /** §M2: eyes closed shorter than this hold the last valid gaze; spec "Smoothing" 500 ms */
    blinkHoldMs: number;
    /** §M2: HEAD_ONLY (and long closures) use head + this margin */
    headOnlyMarginDeg: number;
    /** T6 review m2: a net value is carried at most max(this, 2 × gazeNetEvery frame intervals) */
    netHoldMinMs: number;
    /**
     * T16: a net configuration with no net value uses the geometric path against its own centre (true), or the
     * head (false). False only for the diagnostics' pure-net shadow engine (T16 r3 m3), so its column is net-only.
     */
    netFallback: boolean;
  };

  geometric: {
    /** §M1a: eyeball radius ÷ palpebral width */
    kEye: number;
    /** §M1a: gain on the eye pitch */
    gPitch: number;
    /** §M1a: past this |head yaw| the near eye alone is used */
    nearEyeYawDeg: number;
    /** §M1a: with no reliable eye, head + this */
    fallbackMarginDeg: number;
  };

  calibration: {
    /** §M3 straight flag: |course rate| below this, spec "Vehicle context" ~2°/s */
    straightCourseRateDegS: number;
    /** …on this many consecutive valid rows (3 s at 1 Hz) */
    straightRows: number;
    /** …at ≥ this speed */
    straightMinSpeedKmh: number;
    /** rev1 I5: gyro veto, a yaw-rate peak above this on any of those rows */
    gyroVetoDegS: number;
    /** §M3 admission: speed ≥ this */
    admitMinSpeedKmh: number;
    /** §M3: admitted weight = frame dt, capped */
    admitDtCapS: number;
    /** §M3 histogram, driver frame */
    histYawDeg: [number, number];
    histPitchDeg: [number, number];
    binDeg: number;
    /** spec Stage 1 step 3: Gaussian σ ≈ 2° */
    sigmaDeg: number;
    /** kernel half-width, bins (±3σ) */
    kernelHalfBins: number;
    /** smoothing runs at most this often */
    evalMinIntervalS: number;
    /** spec Stage 1 step 5: p85 of the angular distance within confidenceWithinDeg */
    radiusPercentile: number;
    radiusMinDeg: number;
    radiusMaxDeg: number;
    /** spec Stage 1 step 6: ≥ 70 % of the weight within 15° of the mode */
    confidenceWithinDeg: number;
    confidenceMinShare: number;
    /** §M3 first evaluation: ≥ 60 s driving at ≥ 20 km/h with ≥ 20 s admitted */
    firstEvalDrivingS: number;
    firstEvalAdmittedS: number;
    reevalEveryS: number;
    /** sliding window of samples, and the give-up time (spec: "up to 3 min") */
    windowS: number;
    giveUpS: number;
    /** rev1 m6: running median head pitch over this window before calibration */
    runningMedianS: number;
    /** §M3 provisional EAR: p90 over the first 20 s of TRACKING within ±15° of the running median */
    provisionalEarS: number;
    provisionalEarPercentile: number;
    provisionalEarWithinDeg: number;
    /** rev1 I4, C-23: neutral MAR = max(median, 0.05) */
    neutralMarFloor: number;
    /** spec "Staying calibrated": EMA τ ≈ 3 min, drift capped at 0.5°/min */
    emaTauS: number;
    emaWithinExtraDeg: number;
    emaMaxDegPerMin: number;
    /** rev1 m5 bump step test */
    bumpHalfWindowS: number;
    bumpAngleDeg: number;
    bumpBoxShift: number;
    bumpIodFrac: number;
    bumpSpanS: number;
    /** rev1 I7 continuity: the signature from the last 10 s of TRACKING */
    signatureS: number;
    /** …compared over the first 5 s after a resume */
    resumeCompareS: number;
    /** C-6: a SEARCH longer than this also stores and compares a signature */
    longSearchS: number;
    /** C-6 tolerances */
    resumeTolerance: { yawDeg: number; pitchDeg: number; rollDeg: number; box: number; iodFrac: number };
    /** rev1 I7: a mismatch this large is a driver change */
    driverChange: { iodFrac: number; box: number };
    /** rev2 R1-m2 openness sanity check after every resume */
    opennessCheckS: number;
    opennessCheckMinRelPitchDeg: number;
    opennessRange: [number, number];
    /** §M3 C2 seed: the last 3 s, ≥ 2 s of frames, gaze SD ≤ 3° */
    seedWindowS: number;
    seedMinS: number;
    seedMaxSdDeg: number;
    /** spec anti-annoyance 6: the warm-up */
    warmupS: number;
  };

  zones: {
    table: ZoneSpec[];
    /** §M4; spec "Smoothing": 2–3° */
    hysteresisDeg: number;
    /** §M4, C-16: +5° per condition, capped */
    widenDeg: number;
    widenCapDeg: number;
    /** §M4 junction: yaw rate > 8°/s below 40 km/h → forward road +30° toward the turn */
    junctionMinYawRateDegS: number;
    junctionMaxSpeedKmh: number;
    junctionExtendDeg: number;
    /** §M4 curve: ≥ 2°/s on ≥ 3 rows at ≥ 40 km/h → clamp((rate − 2)/6, 0, 1) × 15° */
    curveMinYawRateDegS: number;
    curveRows: number;
    curveMinSpeedKmh: number;
    curveRampDegS: number;
    curveMaxExtendDeg: number;
    /** C-8: far lateral from LOST only within this long after a fast turn */
    farLateralAfterTurnS: number;
    /** C-18: a fast head turn, °/s */
    fastTurnDegS: number;
    /** C-8 (rev0): the fast turn must fall within this long before the loss… */
    fastTurnWindowMs: number;
    /** …or the last relative head yaw must exceed this */
    lostLateralYawDeg: number;
    /** §M4 zone learning */
    fixationMaxDispersionDeg: number;
    fixationMinMs: number;
    fixationsPerDrive: number;
    dbscanEpsDeg: number;
    dbscanMinPts: number;
    learnEveryS: number;
    mirrorMedianMaxS: number;
    mirrorNearDeg: number;
    drivesToAdopt: number;
    ellipseSigmas: number;
    ellipseMinHalfWidthDeg: number;
    /**
     * T7 review I2: a learned mirror's half-widths are capped, its centroid stays within mirrorNearDeg of
     * the default rectangle, and it may not reach within calibration.radiusMaxDeg of the centre, so a
     * mis-learned mirror can never swallow the forward road.
     */
    learnedMaxHalfWidthDeg: number;
  };

  glances: {
    /** spec "Smoothing": a glance ends after ≥ 100 ms back on road */
    endOnRoadMs: number;
    /** spec "Logged only": a non-driving glance > 2 s (NHTSA) */
    logNonDrivingS: number;
    /** spec "Logged only": mirror checks per minute at speed */
    mirrorRateMinSpeedKmh: number;
    /** spec "Logged only": no scanning */
    noScanningDispersionDeg: number;
    noScanningS: number;
    noScanningMinSpeedKmh: number;
  };

  distraction: {
    /** §M5 speed gates: below this no distraction alert */
    noAlertBelowKmh: number;
    /** …below this log only; D1–D3 at or above it */
    logOnlyBelowKmh: number;
    d1: {
      /** spec Rule D1: 6.0 s at 20–50 km/h */
      bufferCityS: number;
      /** …3.0 s at ≥ 50 km/h */
      bufferFastS: number;
      fastFromKmh: number;
      /** spec anti-annoyance 9 */
      sensitivity: Record<Sensitivity, number>;
      /** …Low capped at ADDW: 6 s at 20–50, 3.5 s at ≥ 50 */
      lowCapCityS: number;
      lowCapFastS: number;
      /** spec Rule D1: refill starts after 100 ms on road */
      refillAfterMs: number;
      /** spec anti-annoyance 2: re-arms at ≥ 50 % */
      rearmFraction: number;
    };
    d2: {
      /** §M5, rev1 I1 (C-21) */
      bucketMs: number;
      resetOnRoadS: number;
      windowS: number;
      warnS: number;
    };
    d3: { minGlances: number; minLapS: number; withinS: number; minSpeedKmh: number; cooldownS: number };
    d4: { returnWithinS: number };
    /**
     * plan §M2 (rev0 "at 5 fps no gaze rule runs"): D1–D4 need a measured fps at or above this. Every fps
     * floor sits BETWEEN two capture rates, never on one, so measurement noise cannot flip it (T6 review
     * I2): 6.5 separates 8 from 5.
     */
    gazeRulesMinFps: number;
    /** C-18 (rev1 m3): a mirror glance ended this recently makes a far-lateral glance a shoulder check */
    shoulderAfterMirrorS: number;
  };

  closure: {
    /** §M6, C-22: closed ⇔ max(reliable eyes) < 0.30; open ⇔ > 0.45 */
    closedBelow: number;
    openAbove: number;
    /** spec "Eye-closure measurement": past ~25° yaw, the near eye */
    nearEyeYawDeg: number;
    /** §M6 looking-down gate */
    lookDownRelPitchDeg: number;
    lookDownClosedBelow: number;
    f1: { closedS: number; lookDownClosedS: number; minSpeedKmh: number };
    f2: { closedS: number; minSpeedKmh: number };
    f3: { closedS: number; noOnRoadS: number; minSpeedKmh: number };
    /** §M6 F4 (C-25, a plan choice): two F1 within 10 min → Severe for 15 min */
    f4: { windowS: number; holdS: number };
    /** spec "Fast rules": one F1 → at least Drowsy for 15 min */
    singleF1HoldS: number;
    /** spec "Fatigue score": a long blink is ≥ 500 ms */
    longBlinkMs: number;
    /** R-U4: blink statistics only at 15 fps; the floor 12.5 separates 15 from 10 (T6 review I2) */
    blinkMinFps: number;
    /** §M6 (rev0): the measured fps is the median frame dt over the last 10 s */
    fpsWindowS: number;
    /**
     * C-26 (T9 review I1), closure bridging: a closure of ≥ bridgeMinClosedMs whose face is then lost
     * with the head down (rel pitch ≤ −nod.referenceWithinDeg, or a fall of ≥ bridgeHeadDropDeg within
     * bridgeDropWindowS) and no C-8 turn keeps running through HEAD_ONLY/LOST, for at most bridgeMaxS.
     */
    bridgeMinClosedMs: number;
    bridgeHeadDropDeg: number;
    bridgeDropWindowS: number;
    bridgeMaxS: number;
    /**
     * T12 review I1: a frame more than this after the previous one is a GAP. The time between is
     * unobserved: it never counts toward D1/D2, glances, closures, the warm-up, fatigue or the summary.
     * Above two frame intervals at the lowest capture rate, below every alert time.
     */
    maxFrameGapS: number;
    /**
     * Final review round 3 (R2-1): an UNBRIDGED closure seen closed on both sides of a gap continues (on
     * observed time) only across a gap of at most this; a longer one ends it silently, and a closed eye after
     * it starts a new closure. Covers dropped frames and an in-flight timeout, never a fault retry, a gate
     * flap or a pause. In (maxFrameGapS, bridgeMaxS).
     */
    maxContinueGapS: number;
  };

  nod: {
    /** §M6, spec "Head-nod detector" */
    referenceWithinDeg: number;
    dropDeg: number;
    dropWithinS: number;
    opennessBelow: number;
    recoverDegS: number;
    recoverWithinS: number;
    /** rev1 I3, C-15: microsleep_nod needs openness < 0.15 held ≥ 0.5 s */
    closureOpenness: number;
    closureHoldS: number;
    minSpeedKmh: number;
  };

  yawn: {
    /** §M6, rev1 I4 */
    openness: number;
    absMar: number;
    heldS: number;
    rampFrom: number;
    rampMinS: number;
    /** speech rejection: DFT energy ratio in [3, min(8, fps/2)] Hz over [0.3, fps/2] Hz */
    speechBandHz: [number, number];
    speechRefLowHz: number;
    speechMaxRatio: number;
    speechWindowS: number;
    /** laugh rejection: mouth width ≥ 1.15 × neutral */
    laughWidthRatio: number;
    /** rev1 m7: disabled below 10 fps; the floor 9 separates 10 from 8 (T6 review I2) */
    minFps: number;
  };

  fatigue: {
    /** §M7 */
    activeAfterS: number;
    minSpeedKmh: number;
    everyS: number;
    minTrackingShare: number;
    signals: {
      perclos: FatigueSignal;
      longBlinks: FatigueSignal;
      blinkDuration: FatigueSignal;
      nods: FatigueSignal;
      yawns: FatigueSignal;
      dispersion: FatigueSignal;
    };
    longTripS: number;
    longTripFactor: number;
    /** local minutes [start, end) */
    nightStartMin: number;
    nightEndMin: number;
    nightFactor: number;
    cap: number;
    /** early, drowsy, severe */
    levels: [number, number, number];
    earlyEveryS: number;
    drowsyEveryS: number;
    severeEveryS: number;
    /** §M7 PERCLOS P80 (rev0): openness below 0.2 (closure.lookDownClosedBelow under the looking-down gate) */
    perclosOpennessBelow: number;
    /** …valid only with ≥ 30 s of TRACKING in its window */
    perclosMinTrackingS: number;
    /** T10 r1 m2: a minute whose surviving row weights sum below this is `insufficient` (nods + dispersion = 0.25 still scores) */
    minScoredWeight: number;
  };

  alerts: {
    /** §M8 tiers */
    tier2RepeatS: number;
    tier3LouderEveryS: number;
    tier3ClearS: number;
    /** a held-back Tier 1 or fatigue burst waits this long, then is dropped */
    heldBackMaxS: number;
    /** anti-annoyance 3: Tier 1 at most once per 10 min per type */
    tier1EveryS: number;
    /** anti-annoyance 4, rev1 I6: Critical starts at ≥ 10 km/h, ends on its stop or known < 10 km/h for 5 s */
    criticalMinStartKmh: number;
    criticalEndBelowKmh: number;
    criticalEndAfterS: number;
    /**
     * T13 r1 I1: with the camera off at speed (heat, dark) a running Critical keeps sounding; after this
     * long with no frame it stops (blind_cap) and a Tier 1 `monitoring_paused` plays once.
     */
    criticalBlindMaxS: number;
    /**
     * U-23 (final review I3, the user's ruling, reversible): a Critical with no TRACKING face this long
     * (continuous time across LOST, HEAD_ONLY and blind stretches; only a TRACKING frame resets it) stops
     * (lost_cap) and a Tier 1 `monitoring_paused` (cause face_lost) plays once.
     */
    criticalLostMaxS: number;
    /** anti-annoyance 8: three Tier 2 distraction warnings in 10 min → a Tier 1 line */
    repeatedGlancesCount: number;
    repeatedGlancesWithinS: number;
  };

  scoring: {
    /** §M10: a focus sample is a non-driving glance longer than this */
    focusGlanceS: number;
    focusQueueCap: number;
  };

  summary: {
    /** §M9, U-11: cameraSession 'good' = ≥ 10 min monitored, ≥ 70 % TRACKING, blinks seen (liveness) */
    goodSessionMinMonitoredS: number;
    goodSessionMinTrackingShare: number;
    goodSessionMinBlinksPer2Min: number;
    /** final review I5: cameraSession 'good' also needs camera-off time at speed ≤ this share */
    goodSessionMaxCameraOffShare: number;
    /** T11 review m3 (moved to config, final review m7): attentionScore needs this share of monitored time with a zone */
    minObservedShare: number;
  };
}

// ---------------------------------------------------------------------------------------------
// The default.
// ---------------------------------------------------------------------------------------------

const zone = (
  id: ZoneId,
  region: ZoneRegion,
  cls: ZoneClass,
  graceS: number,
  weight: number,
  extra: Partial<Pick<ZoneSpec, 'shoulderCheckGraceS' | 'learnable'>> = {}
): ZoneSpec => ({ id, region, class: cls, graceS, weight, shoulderCheckGraceS: extra.shoulderCheckGraceS ?? null, learnable: extra.learnable ?? false });

const DEFAULT: DmsConfig = {
  v: 1,
  gazeSource: 'geometric',
  gazeNetEvery: 2,
  context: { rowStaleMs: 3000, rowTickMs: 1000, tunnelHoldMs: 600_000, unknownStillHoldMs: 10_000, courseMinSpeedMs: 2, turnSignMinDegS: 2, handlingMinScore: 0.6 },
  quality: {
    lostMinBoxArea: 0.01,
    lostMaxFaceLuma: 25,
    lowLightFrameLuma: 25,
    eyeMinLuma: 0.45,
    eyeMinIrisContrast: 12,
    eyeMaxSat: 0.25,
    eyeMinWidthPx: 10,
    headOnlyYawDeg: 40,
    headOnlyMinBlur: 15,
    headOnlyMinFaceLuma: 50,
    limitedNoticeS: 10,
    limitedMinSpeedKmh: 20,
    irisRecencyS: 10,
  },
  gaze: { blinkHoldMs: 500, headOnlyMarginDeg: 5, netHoldMinMs: 300, netFallback: true },
  geometric: { kEye: 0.43, gPitch: 1.0, nearEyeYawDeg: 25, fallbackMarginDeg: 5 },
  calibration: {
    straightCourseRateDegS: 2,
    straightRows: 3,
    straightMinSpeedKmh: 30,
    gyroVetoDegS: 6,
    admitMinSpeedKmh: 20,
    admitDtCapS: 0.2,
    histYawDeg: [-75, 75],
    histPitchDeg: [-50, 50],
    binDeg: 1,
    sigmaDeg: 2,
    kernelHalfBins: 6,
    evalMinIntervalS: 1,
    radiusPercentile: 0.85,
    radiusMinDeg: 8,
    radiusMaxDeg: 15,
    confidenceWithinDeg: 15,
    confidenceMinShare: 0.7,
    firstEvalDrivingS: 60,
    firstEvalAdmittedS: 20,
    reevalEveryS: 30,
    windowS: 180,
    giveUpS: 180,
    runningMedianS: 30,
    provisionalEarS: 20,
    provisionalEarPercentile: 0.9,
    provisionalEarWithinDeg: 15,
    neutralMarFloor: 0.05,
    emaTauS: 180,
    emaWithinExtraDeg: 5,
    emaMaxDegPerMin: 0.5,
    bumpHalfWindowS: 5,
    bumpAngleDeg: 6,
    bumpBoxShift: 0.08,
    bumpIodFrac: 0.12,
    bumpSpanS: 2,
    signatureS: 10,
    resumeCompareS: 5,
    longSearchS: 30,
    resumeTolerance: { yawDeg: 4, pitchDeg: 4, rollDeg: 3, box: 0.05, iodFrac: 0.1 },
    driverChange: { iodFrac: 0.15, box: 0.15 },
    opennessCheckS: 10,
    opennessCheckMinRelPitchDeg: -15,
    opennessRange: [0.6, 1.4],
    seedWindowS: 3,
    seedMinS: 2,
    seedMaxSdDeg: 3,
    warmupS: 60,
  },
  zones: {
    // §M4 table; spec "The zones built from the road centre" and Rule D1's grace and weights.
    table: [
      zone('road_centre', { kind: 'centre' }, 'on_road', 0, 0),
      zone('phone_screen', { kind: 'camera', radiusDeg: 8 }, 'non_driving', 0, 1.0),
      zone('rear_mirror', { kind: 'rect', yaw: [20, 35], pitch: [5, 15] }, 'driving', 1.0, 1.0, { learnable: true }),
      zone('forward_road', { kind: 'rect', yaw: [-25, 30], pitch: [-10, 12] }, 'on_road', 0, 0),
      zone('driver_mirror', { kind: 'rect', yaw: [-60, -30], pitch: [-12, 10] }, 'driving', 1.0, 1.0, { learnable: true }),
      zone('passenger_mirror', { kind: 'rect', yaw: [45, 60], pitch: [-12, 10] }, 'driving', 1.0, 1.0, { learnable: true }),
      zone('cluster', { kind: 'rect', yaw: [-12, 12], pitch: [-25, -10] }, 'driving', 1.0, 1.0),
      zone('lap', { kind: 'below', maxPitchDeg: -30, maxAbsYawDeg: 60 }, 'non_driving', 0, 1.25),
      zone('centre_stack', { kind: 'rect', yaw: [15, 45], pitch: [-30, -10] }, 'non_driving', 0, 1.0),
      zone('far_lateral', { kind: 'lateral', minAbsYawDeg: 60 }, 'non_driving', 0, 1.5, { shoulderCheckGraceS: 1.0 }),
      zone('other', { kind: 'rest' }, 'non_driving', 0, 1.0),
    ],
    hysteresisDeg: 2.5,
    widenDeg: 5,
    widenCapDeg: 10,
    junctionMinYawRateDegS: 8,
    junctionMaxSpeedKmh: 40,
    junctionExtendDeg: 30,
    curveMinYawRateDegS: 2,
    curveRows: 3,
    curveMinSpeedKmh: 40,
    curveRampDegS: 6,
    curveMaxExtendDeg: 15,
    farLateralAfterTurnS: 5,
    fastTurnDegS: 100,
    fastTurnWindowMs: 300,
    lostLateralYawDeg: 45,
    fixationMaxDispersionDeg: 2,
    fixationMinMs: 200,
    fixationsPerDrive: 600,
    dbscanEpsDeg: 3,
    dbscanMinPts: 5,
    learnEveryS: 300,
    mirrorMedianMaxS: 1,
    mirrorNearDeg: 10,
    drivesToAdopt: 3,
    ellipseSigmas: 2,
    ellipseMinHalfWidthDeg: 4,
    learnedMaxHalfWidthDeg: 10,
  },
  glances: {
    endOnRoadMs: 100,
    logNonDrivingS: 2.0,
    mirrorRateMinSpeedKmh: 50,
    noScanningDispersionDeg: 2,
    noScanningS: 15,
    noScanningMinSpeedKmh: 50,
  },
  distraction: {
    noAlertBelowKmh: 10,
    logOnlyBelowKmh: 20,
    d1: {
      bufferCityS: 6.0,
      bufferFastS: 3.0,
      fastFromKmh: 50,
      sensitivity: { low: 1.15, normal: 1.0, high: 0.85 },
      lowCapCityS: 6.0,
      lowCapFastS: 3.5,
      refillAfterMs: 100,
      rearmFraction: 0.5,
    },
    d2: { bucketMs: 100, resetOnRoadS: 2.0, windowS: 30, warnS: 10.0 },
    d3: { minGlances: 3, minLapS: 1.0, withinS: 30, minSpeedKmh: 20, cooldownS: 600 },
    d4: { returnWithinS: 3.0 },
    gazeRulesMinFps: 6.5,
    shoulderAfterMirrorS: 2,
  },
  closure: {
    closedBelow: 0.3,
    openAbove: 0.45,
    nearEyeYawDeg: 25,
    lookDownRelPitchDeg: -15,
    lookDownClosedBelow: 0.15,
    f1: { closedS: 1.0, lookDownClosedS: 1.5, minSpeedKmh: 20 },
    f2: { closedS: 3.0, minSpeedKmh: 10 },
    f3: { closedS: 6.0, noOnRoadS: 3.0, minSpeedKmh: 10 },
    f4: { windowS: 600, holdS: 900 },
    singleF1HoldS: 900,
    longBlinkMs: 500,
    blinkMinFps: 12.5,
    fpsWindowS: 10,
    bridgeMinClosedMs: 500,
    bridgeHeadDropDeg: 5,
    bridgeDropWindowS: 1,
    bridgeMaxS: 10,
    maxFrameGapS: 0.5,
    maxContinueGapS: 1,
  },
  nod: {
    referenceWithinDeg: 5,
    dropDeg: 15,
    dropWithinS: 1.0,
    opennessBelow: 0.5,
    recoverDegS: 30,
    recoverWithinS: 2.0,
    closureOpenness: 0.15,
    closureHoldS: 0.5,
    minSpeedKmh: 20,
  },
  yawn: {
    openness: 2.5,
    absMar: 0.35,
    heldS: 2.0,
    rampFrom: 1.5,
    rampMinS: 0.3,
    speechBandHz: [3, 8],
    speechRefLowHz: 0.3,
    speechMaxRatio: 0.35,
    speechWindowS: 2,
    laughWidthRatio: 1.15,
    minFps: 9,
  },
  fatigue: {
    activeAfterS: 600,
    minSpeedKmh: 20,
    everyS: 60,
    minTrackingShare: 0.5,
    signals: {
      // The floors sit between capture rates (T6 review I2): 9 (on at 10, off at 8), 12.5 (on at 15, off at 10).
      perclos: { windowS: 60, target: 0.15, margin: 0.07, weight: 0.3, minFps: 9 },
      longBlinks: { windowS: 300, target: 3, margin: 1.5, weight: 0.2, minFps: 12.5 },
      blinkDuration: { windowS: 300, target: 1.5, margin: 0.25, weight: 0.15, minFps: 12.5 },
      nods: { windowS: 600, target: 2, margin: 1, weight: 0.15, minFps: 0 },
      yawns: { windowS: 900, target: 3, margin: 1, weight: 0.1, minFps: 9 },
      dispersion: { windowS: 300, target: 0.5, margin: null, weight: 0.1, minFps: 0 },
    },
    longTripS: 7200,
    longTripFactor: 1.15,
    nightStartMin: 0,
    nightEndMin: 360,
    nightFactor: 1.15,
    cap: 100,
    levels: [40, 60, 80],
    earlyEveryS: 1200,
    drowsyEveryS: 300,
    severeEveryS: 120,
    perclosOpennessBelow: 0.2,
    perclosMinTrackingS: 30,
    minScoredWeight: 0.25,
  },
  alerts: {
    tier2RepeatS: 1,
    tier3LouderEveryS: 2,
    tier3ClearS: 1.0,
    heldBackMaxS: 10,
    tier1EveryS: 600,
    criticalMinStartKmh: 10,
    criticalEndBelowKmh: 10,
    criticalEndAfterS: 5,
    criticalBlindMaxS: 60,
    criticalLostMaxS: 60,
    repeatedGlancesCount: 3,
    repeatedGlancesWithinS: 600,
  },
  scoring: { focusGlanceS: 2.0, focusQueueCap: 32 },
  summary: { goodSessionMinMonitoredS: 600, goodSessionMinTrackingShare: 0.7, goodSessionMinBlinksPer2Min: 1, goodSessionMaxCameraOffShare: 0.3, minObservedShare: 0.5 },
};

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export const DEFAULT_DMS_CONFIG: DeepReadonly<DmsConfig> = deepFreeze(DEFAULT);

// ---------------------------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------------------------

/** Paths whose numbers may be negative (signed angles). Everything else must be ≥ 0. */
const SIGNED = [
  /^calibration\.histYawDeg\b/,
  /^calibration\.histPitchDeg\b/,
  /^calibration\.opennessCheckMinRelPitchDeg$/,
  /^closure\.lookDownRelPitchDeg$/,
  /^zones\.table\[\w+\]\.region\./,
];

/** Paths that are fractions in [0, 1]. */
const FRACTIONS = [
  'quality.eyeMinLuma',
  'quality.eyeMaxSat',
  'quality.lostMinBoxArea',
  'calibration.radiusPercentile',
  'calibration.confidenceMinShare',
  'calibration.provisionalEarPercentile',
  'distraction.d1.rearmFraction',
  'closure.closedBelow',
  'closure.openAbove',
  'closure.lookDownClosedBelow',
  'nod.opennessBelow',
  'nod.closureOpenness',
  'yawn.speechMaxRatio',
  'fatigue.minTrackingShare',
  'context.handlingMinScore',
  'fatigue.perclosOpennessBelow',
  'summary.goodSessionMinTrackingShare',
];

/** The longest grace a zone may have before D1 drains (the spec's is 1.0 s). */
const MAX_GRACE_S = 5;

function walkNumbers(v: unknown, path: string, out: [string, number][]): void {
  if (typeof v === 'number') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => walkNumbers(x, `${path}[${i}]`, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) walkNumbers(x, path === '' ? k : `${path}.${k}`, out);
  }
}

/** Every rule the config must satisfy; returns the problems (empty when valid). */
export function validateDmsConfig(input: DeepReadonly<DmsConfig> | DmsConfig): string[] {
  const c = input as DmsConfig;
  const errors: string[] = [];
  const bad = (path: string, why: string) => errors.push(`${path}: ${why}`);

  if (c.v !== 1) bad('v', 'must be 1');
  if (c.gazeSource !== 'geometric' && c.gazeSource !== 'net') bad('gazeSource', "must be 'geometric' or 'net'");
  if (c.gazeNetEvery !== 1 && c.gazeNetEvery !== 2) bad('gazeNetEvery', 'must be 1 or 2');

  // Every number: finite, and non-negative unless it is a signed angle. Zone tables are named by id.
  const nums: [string, number][] = [];
  const named = { ...c, zones: { ...c.zones, table: undefined } } as unknown;
  walkNumbers(named, '', nums);
  (c.zones?.table ?? []).forEach((z) => walkNumbers(z, `zones.table[${String(z.id)}]`, nums));
  for (const [path, n] of nums) {
    if (!Number.isFinite(n)) bad(path, 'must be a finite number');
    else if (n < 0 && !SIGNED.some((re) => re.test(path))) bad(path, 'must be ≥ 0');
  }
  const at = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], c);
  for (const path of FRACTIONS) {
    const n = at(path);
    if (typeof n === 'number' && !(n >= 0 && n <= 1)) bad(path, 'must lie in [0, 1]');
  }

  const ordered = (path: string, r: readonly number[] | undefined) => {
    if (!Array.isArray(r) || r.length !== 2 || !(r[0]! < r[1]!)) bad(path, 'must be an ordered [low, high] pair');
  };

  if (typeof c.gaze.netFallback !== 'boolean') bad('gaze.netFallback', 'must be a boolean');
  if (!(c.quality.irisRecencyS > 0)) bad('quality.irisRecencyS', 'must be > 0');
  if (!(c.closure.bridgeMaxS > c.closure.f3.closedS)) bad('closure.bridgeMaxS', 'must exceed closure.f3.closedS (C-26: F3 fires inside a bridge)');
  if (!(c.closure.bridgeDropWindowS > 0)) bad('closure.bridgeDropWindowS', 'must be > 0');
  if (!(c.alerts.criticalBlindMaxS > c.alerts.criticalEndAfterS)) bad('alerts.criticalBlindMaxS', 'must exceed alerts.criticalEndAfterS');
  if (!(c.alerts.criticalLostMaxS > c.alerts.criticalEndAfterS)) bad('alerts.criticalLostMaxS', 'must exceed alerts.criticalEndAfterS');
  // Final review m7: the orderings the code relies on.
  if (!(c.context.rowTickMs > 0)) bad('context.rowTickMs', 'must be > 0');
  if (!(c.context.rowStaleMs > c.context.rowTickMs)) bad('context.rowStaleMs', 'must exceed context.rowTickMs (the row period)');
  if (!(c.alerts.criticalEndBelowKmh <= c.alerts.criticalMinStartKmh)) bad('alerts.criticalEndBelowKmh', 'must be ≤ alerts.criticalMinStartKmh');
  if (!(c.alerts.tier3ClearS > 0)) bad('alerts.tier3ClearS', 'must be > 0');
  if (!Number.isInteger(c.fatigue.everyS) || c.fatigue.everyS <= 0) bad('fatigue.everyS', 'must be a positive integer');
  for (const [name, row] of Object.entries(c.fatigue.signals)) {
    if (!Number.isInteger(row.windowS) || row.windowS <= 0) bad(`fatigue.signals.${name}.windowS`, 'must be a positive integer');
  }
  if (!(c.summary.minObservedShare >= 0 && c.summary.minObservedShare <= 1)) bad('summary.minObservedShare', 'must lie in [0, 1]');
  if (!(c.summary.goodSessionMaxCameraOffShare >= 0 && c.summary.goodSessionMaxCameraOffShare <= 1)) bad('summary.goodSessionMaxCameraOffShare', 'must lie in [0, 1]');
  const twoSlowFrames = 2 / Math.min(...ALLOWED_FPS);
  if (!(c.closure.maxFrameGapS > twoSlowFrames + 1e-9)) bad('closure.maxFrameGapS', `must exceed two frame intervals at the lowest capture rate (${twoSlowFrames} s)`);
  if (!(c.closure.maxContinueGapS > c.closure.maxFrameGapS && c.closure.maxContinueGapS < c.closure.bridgeMaxS)) {
    bad('closure.maxContinueGapS', 'must lie in (closure.maxFrameGapS, closure.bridgeMaxS)');
  }

  // Geometric gaze.
  if (!(c.geometric.kEye > 0 && c.geometric.kEye <= 1)) bad('geometric.kEye', 'must lie in (0, 1]');
  if (!(c.geometric.gPitch > 0)) bad('geometric.gPitch', 'must be > 0');

  // Calibration.
  ordered('calibration.histYawDeg', c.calibration.histYawDeg);
  ordered('calibration.histPitchDeg', c.calibration.histPitchDeg);
  ordered('calibration.opennessRange', c.calibration.opennessRange);
  if (!(c.calibration.binDeg > 0)) bad('calibration.binDeg', 'must be > 0');
  if (!(c.calibration.radiusMinDeg <= c.calibration.radiusMaxDeg)) bad('calibration.radiusMinDeg', 'must be ≤ radiusMaxDeg');
  if (!(c.calibration.driverChange.iodFrac > c.calibration.resumeTolerance.iodFrac)) {
    bad('calibration.driverChange.iodFrac', 'must exceed resumeTolerance.iodFrac');
  }
  if (!(c.calibration.driverChange.box > c.calibration.resumeTolerance.box)) bad('calibration.driverChange.box', 'must exceed resumeTolerance.box');
  if (!(c.calibration.seedMinS <= c.calibration.seedWindowS)) bad('calibration.seedMinS', 'must be ≤ seedWindowS');
  for (const k of ['straightRows'] as const) if (!Number.isInteger(c.calibration[k]) || c.calibration[k] < 1) bad(`calibration.${k}`, 'must be a positive integer');

  // Zones.
  const ids = (c.zones.table ?? []).map((z) => z.id);
  if (JSON.stringify(ids) !== JSON.stringify(ZONE_IDS)) bad('zones.table', `must list exactly ${ZONE_IDS.join(', ')} in that order`);
  for (const z of c.zones.table ?? []) {
    const p = `zones.table[${String(z.id)}]`;
    if (z.class !== 'on_road' && z.class !== 'driving' && z.class !== 'non_driving') bad(`${p}.class`, 'is not a zone class');
    if (z.class === 'on_road' ? z.weight !== 0 : !(z.weight > 0)) bad(`${p}.weight`, z.class === 'on_road' ? 'must be 0 (on-road zones refill)' : 'must be > 0');
    const r = z.region;
    if (r.kind === 'rect') {
      ordered(`${p}.region.yaw`, r.yaw);
      ordered(`${p}.region.pitch`, r.pitch);
    } else if (r.kind === 'camera' && !(r.radiusDeg > 0)) bad(`${p}.region.radiusDeg`, 'must be > 0');
    else if (r.kind === 'below') {
      if (!(r.maxPitchDeg < 0)) bad(`${p}.region.maxPitchDeg`, 'must be < 0 (below the centre)');
      if (!(r.maxAbsYawDeg > 0)) bad(`${p}.region.maxAbsYawDeg`, 'must be > 0');
    } else if (r.kind === 'lateral' && !(r.minAbsYawDeg > 0)) bad(`${p}.region.minAbsYawDeg`, 'must be > 0');
    if (!(z.graceS <= MAX_GRACE_S)) bad(`${p}.graceS`, `must be ≤ ${MAX_GRACE_S}`);
    const shoulder = z.id === 'far_lateral';
    if (shoulder ? !(typeof z.shoulderCheckGraceS === 'number' && z.shoulderCheckGraceS <= MAX_GRACE_S) : z.shoulderCheckGraceS !== null) {
      bad(`${p}.shoulderCheckGraceS`, shoulder ? `must be a number ≤ ${MAX_GRACE_S}` : 'only far_lateral has a shoulder-check grace');
    }
  }
  if (!(c.zones.widenCapDeg >= c.zones.widenDeg)) bad('zones.widenCapDeg', 'must be ≥ widenDeg');
  if (!(c.zones.learnedMaxHalfWidthDeg >= c.zones.ellipseMinHalfWidthDeg)) bad('zones.learnedMaxHalfWidthDeg', 'must be ≥ ellipseMinHalfWidthDeg');
  // Hysteresis shrinks a zone by its width when entering it: it must leave every rectangle a core.
  const halfSpans = (c.zones.table ?? []).flatMap((z) => (z.region.kind === 'rect' ? [(z.region.yaw[1] - z.region.yaw[0]) / 2, (z.region.pitch[1] - z.region.pitch[0]) / 2] : []));
  if (halfSpans.length > 0 && !(c.zones.hysteresisDeg < Math.min(...halfSpans))) bad('zones.hysteresisDeg', 'must be smaller than half of every rectangular zone');
  for (const k of ['curveRows', 'dbscanMinPts', 'drivesToAdopt', 'fixationsPerDrive'] as const) {
    if (!Number.isInteger(c.zones[k]) || c.zones[k] < 1) bad(`zones.${k}`, 'must be a positive integer');
  }

  // Distraction.
  const d1 = c.distraction.d1;
  if (!(d1.bufferFastS < d1.bufferCityS)) bad('distraction.d1', 'bufferFastS must be < bufferCityS');
  for (const s of ['low', 'normal', 'high'] as const) if (!(d1.sensitivity?.[s] > 0)) bad(`distraction.d1.sensitivity.${s}`, 'must be > 0');
  if (!(d1.lowCapFastS >= d1.bufferFastS && d1.lowCapCityS >= d1.bufferCityS)) bad('distraction.d1', 'the Low caps must be ≥ the normal buffers');
  if (!(c.distraction.noAlertBelowKmh <= c.distraction.logOnlyBelowKmh)) bad('distraction.noAlertBelowKmh', 'must be ≤ logOnlyBelowKmh');
  if (!(c.distraction.gazeRulesMinFps > 0)) bad('distraction.gazeRulesMinFps', 'must be > 0');
  // Every fps floor sits between capture rates, never on one (T6 review I2).
  const floors: [string, number][] = [
    ['distraction.gazeRulesMinFps', c.distraction.gazeRulesMinFps],
    ['closure.blinkMinFps', c.closure.blinkMinFps],
    ['yawn.minFps', c.yawn.minFps],
    ...Object.entries(c.fatigue.signals ?? {}).map(([k, s]) => [`fatigue.signals.${k}.minFps`, s.minFps] as [string, number]),
  ];
  for (const [path, v] of floors) if ((ALLOWED_FPS as readonly number[]).includes(v)) bad(path, `must not equal a capture rate (${ALLOWED_FPS.join(', ')})`);
  const d2 = c.distraction.d2;
  if (!(d2.bucketMs > 0) || (d2.windowS * 1000) % d2.bucketMs !== 0) bad('distraction.d2.bucketMs', 'must divide the window');
  if (!(d2.warnS <= d2.windowS)) bad('distraction.d2.warnS', 'must be ≤ windowS');
  if (!Number.isInteger(c.distraction.d3.minGlances) || c.distraction.d3.minGlances < 1) bad('distraction.d3.minGlances', 'must be a positive integer');

  // Closure.
  const cl = c.closure;
  if (!(cl.closedBelow < cl.openAbove)) bad('closure.closedBelow', 'must be < openAbove (hysteresis)');
  if (!(cl.lookDownClosedBelow <= cl.closedBelow)) bad('closure.lookDownClosedBelow', 'must be ≤ closedBelow');
  if (!(cl.f1.closedS < cl.f2.closedS && cl.f2.closedS < cl.f3.closedS)) bad('closure.f1', 'F1 < F2 < F3 closure times');
  if (!(cl.f1.lookDownClosedS >= cl.f1.closedS)) bad('closure.f1.lookDownClosedS', 'must be ≥ f1.closedS');

  // Nod and yawn.
  if (!(c.nod.closureOpenness < c.nod.opennessBelow)) bad('nod.closureOpenness', 'must be < opennessBelow');
  ordered('yawn.speechBandHz', c.yawn.speechBandHz);
  if (!(c.yawn.rampFrom < c.yawn.openness)) bad('yawn.rampFrom', 'must be < openness');

  // Fatigue.
  const f = c.fatigue;
  const signals = Object.values(f.signals ?? {});
  const total = signals.reduce((s, x) => s + (x?.weight ?? Number.NaN), 0);
  if (!(Math.abs(total - 1) <= 1e-9)) bad('fatigue.signals', `weights must sum to 1 (they sum to ${total})`);
  for (const [name, s] of Object.entries(f.signals ?? {})) {
    if (s.margin !== null && typeof s.margin !== 'number') bad(`fatigue.signals.${name}.margin`, 'must be a number or null');
  }
  const lv = f.levels;
  if (!Array.isArray(lv) || lv.length !== 3 || !(0 < lv[0]! && lv[0]! < lv[1]! && lv[1]! < lv[2]! && lv[2]! <= f.cap)) {
    bad('fatigue.levels', 'must be three ascending levels within (0, cap]');
  }
  for (const k of ['nightStartMin', 'nightEndMin'] as const) if (!(f[k] >= 0 && f[k] <= 1440)) bad(`fatigue.${k}`, 'must lie in [0, 1440]');
  if (!(f.longTripFactor >= 1 && f.nightFactor >= 1)) bad('fatigue', 'amplifying factors must be ≥ 1');
  if (!(c.closure.lookDownClosedBelow < f.perclosOpennessBelow)) bad('fatigue.perclosOpennessBelow', 'must be > closure.lookDownClosedBelow');
  if (!(f.perclosMinTrackingS <= f.signals.perclos.windowS)) bad('fatigue.perclosMinTrackingS', 'must be ≤ the PERCLOS window');
  if (!(f.minScoredWeight > 0 && f.minScoredWeight <= 1)) bad('fatigue.minScoredWeight', 'must lie in (0, 1]');

  if (!Number.isInteger(c.scoring.focusQueueCap) || c.scoring.focusQueueCap < 1) bad('scoring.focusQueueCap', 'must be a positive integer');
  return errors;
}

// ---------------------------------------------------------------------------------------------
// JSON and overrides.
// ---------------------------------------------------------------------------------------------

export function configToJson(c: DeepReadonly<DmsConfig> | DmsConfig): string {
  return JSON.stringify(c);
}

/** Key-by-key shape check against the default: no unknown or missing keys, the same JSON types. */
function checkShape(value: unknown, like: unknown, path: string, errors: string[]): void {
  const kind = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  const here = path === '' ? '(root)' : path;
  if (Array.isArray(like)) {
    if (!Array.isArray(value)) {
      errors.push(`${here}: must be an array`);
      return;
    }
    // A zone table's rows share one shape; tuples ([low, high]) are numbers.
    value.forEach((v, i) => checkShape(v, like[Math.min(i, like.length - 1)], `${path}[${i}]`, errors));
    return;
  }
  if (like !== null && typeof like === 'object') {
    if (kind(value) !== 'object') {
      errors.push(`${here}: must be an object`);
      return;
    }
    const v = value as Record<string, unknown>;
    const l = like as Record<string, unknown>;
    if (path.startsWith('zones.table[') && path.endsWith(']')) {
      // Zone rows: the region's own keys depend on its kind, so only the row keys are fixed.
      for (const k of Object.keys(l)) if (!(k in v)) errors.push(`${path}.${k}: missing`);
      for (const k of Object.keys(v)) if (!(k in l)) errors.push(`${path}.${k}: unknown key`);
      return;
    }
    for (const k of Object.keys(l)) {
      const p = path === '' ? k : `${path}.${k}`;
      if (!(k in v)) errors.push(`${p}: missing`);
      else checkShape(v[k], l[k], p, errors);
    }
    for (const k of Object.keys(v)) if (!(k in l)) errors.push(`${path === '' ? k : `${path}.${k}`}: unknown key`);
    return;
  }
  // A nullable number (the dispersion margin) accepts a number or null.
  const ok = kind(value) === kind(like) || (path.endsWith('.margin') && (kind(value) === 'number' || kind(value) === 'null'));
  if (!ok) errors.push(`${here}: must be a ${kind(like)}`);
}

/** Parses, checks the shape key by key, validates. Throws with every problem. */
export function configFromJson(text: string): DmsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('DmsConfig: not valid JSON');
  }
  const errors: string[] = [];
  checkShape(parsed, DEFAULT_DMS_CONFIG, '', errors);
  if (errors.length === 0) errors.push(...validateDmsConfig(parsed as DmsConfig));
  if (errors.length > 0) throw new Error(`DmsConfig: ${errors.join('; ')}`);
  return parsed as DmsConfig;
}

export type DmsConfigOverrides = {
  [K in keyof DmsConfig]?: DmsConfig[K] extends unknown[] ? DmsConfig[K] : DmsConfig[K] extends object ? DeepPartial<DmsConfig[K]> : DmsConfig[K];
};
type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object | null ? DeepPartial<T[K]> : T[K] };

function merge(base: unknown, over: unknown, path: string, errors: string[]): unknown {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base) || over === null || typeof over !== 'object' || Array.isArray(over)) {
    return over;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const p = path === '' ? k : `${path}.${k}`;
    if (!(k in out)) {
      errors.push(`${p}: unknown key`);
      continue;
    }
    out[k] = merge(out[k], v, p, errors);
  }
  return out;
}

/** The default with a deep partial applied (arrays replace whole). Throws when the result is invalid. */
export function resolveDmsConfig(overrides: DmsConfigOverrides = {}): DmsConfig {
  const errors: string[] = [];
  const merged = merge(JSON.parse(configToJson(DEFAULT_DMS_CONFIG)), overrides, '', errors) as DmsConfig;
  if (errors.length === 0) {
    checkShape(merged, DEFAULT_DMS_CONFIG, '', errors);
    if (errors.length === 0) errors.push(...validateDmsConfig(merged));
  }
  if (errors.length > 0) throw new Error(`DmsConfig: ${errors.join('; ')}`);
  return merged;
}
