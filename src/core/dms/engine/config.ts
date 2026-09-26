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

/** Task C2 (U-14): what stop-time sleep events feed (`fatigue.stopEventsFeed`). */
export const STOP_EVENTS_FEEDS = ['none', 'long_and_nod', 'all'] as const;
export type StopEventsFeed = (typeof STOP_EVENTS_FEEDS)[number];

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
    /**
     * Task C5 (rev1 I1, rev2 §2.3.1): the EMA's gate is the road core, max(emaWithinMinDeg, emaWithinFrac ×
     * radius) (was radius + 5°), so a minority cluster (a phone) never enters the mean
     */
    emaWithinFrac: number;
    emaWithinMinDeg: number;
    emaMaxDegPerMin: number;
    /** Task C5 (rev1 I1): the admitted samples within ±voidS of a D1/D2/D3 warning are removed (the EMA and every window) */
    voidS: number;
    /**
     * Task C6 (rev2 §2.3.4; baselines.ts): the eye and mouth baselines during a drive. EAR up ≤ earUpPctPerMin up to
     * earUpCapFrac × the drive reference; down only on an appearance event (a tier change, the eye luma ≥
     * appearanceLumaFrac against the reference's, the projected IOD ≥ appearanceIodFrac, held appearanceHoldS),
     * with the fatigue gate clear and by the explained factor only (the FACE luma's lumaEarTable × (1 +
     * iodEarPerFrac × ΔiodC): device item K5), read from a checkS window; floored at earFloorFrac × the drive
     * reference (appearance-corrected) and × the profile EAR. A q/b ≤ lowRatio for lowHoldS, or a drop the
     * appearance does not explain (by more than explainTol, held unexplainedHoldS), is fatigue evidence.
     */
    baselines: {
      buckets: number;
      readEveryS: number;
      minReadS: number;
      maxYawDeg: number;
      maxPitchRelDeg: number;
      minOpenness: number;
      earUpPctPerMin: number;
      earUpCapFrac: number;
      earFloorFrac: number;
      appearanceLumaFrac: number;
      appearanceIodFrac: number;
      appearanceHoldS: number;
      checkS: number;
      explainTol: number;
      unexplainedHoldS: number;
      /**
       * C7 round 4 (review-C7 Round 4 ruling, B): the cap on the frame-to-frame EAR noise σ_n that the noise-corrected
       * open-eye reference removes (the deconvolved P90). K12 measures the real value.
       */
      earNoiseMaxSd: number;
      lowRatio: number;
      lowHoldS: number;
      /**
       * Task C7 (rev2 §2.4 H5, rev1 K2): the eyes are degraded when every read eye's q/b is above h5Hi, or below
       * h5Lo WITH a face-luma or IOD appearance event within h5CorroborateS (a downward ratio alone is fatigue
       * evidence, never degradation), held h5HoldS; they recover after h5HoldS good. HUD only: every closure rule
       * and fatigue signal stays.
       */
      h5Lo: number;
      h5Hi: number;
      h5HoldS: number;
      h5CorroborateS: number;
      lumaEarTable: [number, number][];
      iodEarPerFrac: number;
      marUpPctPerMin: number;
      marUpCap10MinFrac: number;
      marDownPctPerMin: number;
      talkMarFactor: number;
      yawnBlockS: number;
    };
    /**
     * Task C5 (rev2 §2.3.3): the rolling path. Every everyS over the last windowS of admission: a small shift
     * (minShiftDeg ≤ d ≤ smallShiftSigmas σ̂, unimodal, two evaluations agreeing) or a larger one up to
     * radiusMinDeg (relatively vacated in two evaluations) is followed at ≤ rateDegPerMin. A pitch-down shift
     * beyond maxPitchDownDeg needs translation evidence. The phone screen's samples are excluded only when the
     * camera is at least radius + screenExtraDeg from the centre (I7).
     */
    rolling: { windowS: number; everyS: number; rateDegPerMin: number; minShiftDeg: number; maxPitchDownDeg: number; screenExtraDeg: number };
    /**
     * Task C5 (rev2 §2.3.3, R3b): the slow uncorroborated path. A peaked, relatively vacated candidate beyond the
     * rolling range (up to maxShiftDeg) that persists persistS of admission, with a road-scanning pattern every
     * minute (≥ scanExcursionsPerMin excursions of ≥ excursionMinDeg yaw from c₀, back within excursionReturnS),
     * enters the dual state. C5 round 1 (review-C5 C5-1): maxShiftDeg is radiusMinDeg + 4.5° (12.5°), and the
     * return points corroborate it: after each excursion the first fixation of returnFixationMs lands nearer the
     * candidate than c₀ for ≥ returnShare of ≥ returnMinCount excursions since the candidate appeared (the rolling
     * large path: of ≥ returnMinCountRolling, or it waits). A shifted road is returned to every time, less the
     * fixation noise (at 8 fps a 300 ms fixation is 2–3 frames: about 86 % land nearer a 5.5° shift), so the share
     * is 0.8 (C5 round 2); a display watched 70 % of the time is held by excessMax (c₀ vacated beyond noise).
     */
    slow: {
      persistS: number;
      maxShiftDeg: number;
      scanExcursionsPerMin: number;
      excursionMinDeg: number;
      excursionReturnS: number;
      returnFixationMs: number;
      returnShare: number;
      returnMinCount: number;
      returnMinCountRolling: number;
      /** C5 round 1: c₀'s share beyond what c₁'s noise explains, as a fraction of c₁'s, for a large or slow follow */
      excessMax: number;
    };
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
    /**
     * C8 round 1 (review-C8 C8-1): a failed warm-start comparison (a profile's mount signature) retries on each next
     * resumeCompareS of TRACKING, until it matches, a Stage 1 pass, or this much moving time (a texting start fails
     * the head-pose signature; a real mount change keeps failing and is never adopted).
     */
    warmRetryS: number;
    /**
     * C7 round 4 (review-C7 Round 4 ruling, B): a legacy profile (no `earNoiseCorrected`, its EAR the inflated P90)
     * may be lowered once, by the drive's first Stage 1 pass, by at most this fraction.
     */
    legacyEarMaxLowerFrac: number;
    /** C-6: a SEARCH longer than this also stores and compares a signature */
    longSearchS: number;
    /** C-6 tolerances */
    resumeTolerance: { yawDeg: number; pitchDeg: number; rollDeg: number; box: number; iodFrac: number };
    /** rev1 I7: a mismatch this large is a driver change */
    driverChange: { iodFrac: number; box: number };
    /**
     * Task C4 (rev2 §2.3.0–§2.3.2; rev1 K1): the posture detector and the dual-centre state. A settled
     * rotation-compensated translation (|ΔboxC| ≥ boxShiftC or |ΔiodC| ≥ iodFracC; the transition ≤ spanS; halves
     * of halfWindowS) opens the dual state; a settled pitch drop of slumpPitchDeg with no translation is a slump.
     */
    posture: {
      boxShiftC: number;
      iodFracC: number;
      halfWindowS: number;
      spanS: number;
      slumpPitchDeg: number;
      /** the onset (half the threshold within 2 s, held 1 s) widens the zones for at most this long */
      onsetWidenMaxS: number;
      /** before the drive's fit: the box moves this much per degree of head rotation (a prior; a device item) */
      boxPerDegPrior: number;
      /**
       * C4 round 1 (review-C4 C4-2): the fit is a ridge toward the prior, λ per axis (deg²): an axis the head's
       * variance supports is learned, the others stay near the prior. Its sums decay with fitDecayS, so a changed
       * mount or seat is followed.
       */
      fitRidgeDeg2: number;
      fitDecayS: number;
      /**
       * C4 round 1 (C4-2): the box-on-head error, × boxPerDegPrior, a translation must exceed to be a step: a
       * compensated box shift that an error of this size (scaled by each axis's unlearned share of the ridge,
       * λ / (variance + λ)) could explain from the step's head change is a look, not a posture step
       */
      fitUncertainty: number;
      /**
       * C4 round 1 (C4-3): a slump is the lowered head held slumpHoldS of observed time, the head yaw within
       * slumpYawDeg of its centre, the gaze on the road (c₀'s road_centre or forward_road) for ≥ slumpOnRoadShare
       */
      slumpHoldS: number;
      slumpYawDeg: number;
      slumpOnRoadShare: number;
      /**
       * C4 round 1 (C4-1): a road-like c₁: inside c₀'s unwidened on-road zones, farther than the phone screen's
       * radius + candidateCameraMarginDeg from the camera, and at most candidateNonDrivingShare of the window's
       * weight in c₀'s non-driving zones; the revert is measured over the last revertWindowS of admission
       */
      candidateCameraMarginDeg: number;
      candidateNonDrivingShare: number;
      revertWindowS: number;
      fitMinSamples: number;
      /** the candidate c₁: the mode of this much admitted weight, within searchMaxS observed, ≤ searchMaxDeg from c₀ */
      searchS: number;
      /**
       * Task C5 (review-C4 deviation 5): searchMaxS counts ADMISSIBLE observed time only (a straight row, or every
       * known turn rate below searchCurveRateDegS), with searchCapS of observed time as the cap, so a step in a
       * long curve is found at its end
       */
      searchMaxS: number;
      searchCurveRateDegS: number;
      searchCapS: number;
      /**
       * Task C5 (review-C4 §5, rev1 K1-C): a commit that lowers the head-centre pitch by at least this needs the
       * fatigue gate clear; otherwise it is fatigue evidence (head_slump) and c₀ is kept
       */
      fatigueCommitPitchDeg: number;
      searchMaxDeg: number;
      /** peaked: the share within ρ = max(4°, 1.3σ̂) of the cluster's weight ≥ this × a single cluster's */
      peakedRatio: number;
      /** commit after this much admitted persistence; revert on this much relative revert, or undecided after this */
      commitS: number;
      revertS: number;
      undecidedMaxS: number;
      /** probation after a commit, and the reversal that reverts it */
      probationS: number;
      probationRevertS: number;
      /** d ≤ this × σ̂ is a small shift (the unimodal path) */
      smallShiftSigmas: number;
      /** vacated: S(c₀, r_v) < this × S(c₁, r_v) */
      vacatedRatio: number;
      /** unimodal: no second peak ≥ this × the main one */
      unimodalRatio: number;
      evalEveryS: number;
      /** a commit with at least this much translation demotes the learned mirrors (U-6) */
      demoteBoxC: number;
      demoteIodFracC: number;
    };
    /**
     * Task C4 (rev5 V2, amendments W1–W3): a driver change across a stop. A LOST run of ≥ swapLostS during the
     * stop arms it; swapTrackS of TRACKING after the face returns runs the provisional check. The interim EAR is
     * from near-forward frames (the head within interimNearDeg) with a blink seen, floored at interimFloor × the
     * old one until confirmed (W1). A camera step (the IOD unchanged, the box shift within cameraStepTolerance of
     * cameraStepBoxPerDeg × the head step) is classified before a driver change (W3).
     */
    stops: {
      swapLostS: number;
      swapTrackS: number;
      interimFloor: number;
      interimNearDeg: number;
      cameraStepBoxPerDeg: number;
      cameraStepTolerance: number;
    };
    /** rev2 R1-m2 openness sanity check after every resume */
    opennessCheckS: number;
    opennessCheckMinRelPitchDeg: number;
    opennessRange: [number, number];
    /**
     * Task C8 (rev2 §2.2 item 3, I3.4): the start check on the first TRACKING of a drive whose EAR came from a
     * profile or seed: a 10 s median openness above startOpennessRange[1] re-derives upward, below [0] re-derives
     * under the downward rule; the MAR (median ÷ reference) outside startMarRange re-derives it.
     */
    startOpennessRange: [number, number];
    startMarRange: [number, number];
    /**
     * Task C8 (rev2 §2.2, rev1 I6): seed verification. An unverified seed (profile, C2 seed, a new driver's W2 seed)
     * widens by +5° with D2 on. Windows of `windowS` admitted weight (TRACKING, eyes open, ≥ admitMinSpeedKmh,
     * straight or turn rates < curveRateDegS), within windowMaxObservedS of observed time. Per window, for the
     * primary source and the head: the mode m, the peakedness P in ρ = max(ringMinDeg, ringSigmas·σ̂) against a single
     * cluster's P₁(σ̂) (peaked: P ≥ peakFrac·P₁), and SE. Agree: peaked and |m − seed| ≤ max(agreeMinDeg, agreeSE·SE)
     * for both → verified. Disagree: two consecutive peaked windows beyond that bound, agreeing within
     * max(pairMinDeg, pairSE·SE) → the dual state (cause 'seed'), which commits or reverts by its own rules.
     */
    seed: {
      admitMinSpeedKmh: number;
      windowS: number;
      windowMaxObservedS: number;
      ringMinDeg: number;
      ringSigmas: number;
      peakFrac: number;
      agreeMinDeg: number;
      agreeSE: number;
      pairMinDeg: number;
      pairSE: number;
      curveRateDegS: number;
      /**
       * C8 round 3 (review-C8 R2-D): a dispute against an UNVERIFIED profile resolves for the pass unless a window
       * agrees with the seed within this much seed-admitted time after the pass (a verified seed's stays open-ended).
       */
      disputeMaxS: number;
    };
    /**
     * Task C8 (rev2 §2.7): a profile is saved only if calibrated or seed-verified, no dual state or probation is
     * pending, gaze health was good and the fatigue gate clear for the last healthyS / gateClearS of the drive.
     */
    save: { healthyS: number; gateClearS: number };
    /** §M3 C2 seed: the last 3 s, ≥ 2 s of frames, gaze SD ≤ 3° */
    seedWindowS: number;
    seedMinS: number;
    seedMaxSdDeg: number;
    /** spec anti-annoyance 6: the warm-up */
    warmupS: number;
  };

  /**
   * Task C7 (rev2 §2.4, rev1 K2): the gaze accuracy monitor (health.ts). H1–H4 on on-road frames of moving,
   * calibrated time; degraded → the on-road zones widen by zones.widenDeg; never a re-centre. Recovery after
   * recoverS of every metric good. H5 (the eyes) lives in the EAR baseline (calibration.baselines.h5*).
   */
  health: {
    h1TauS: number;
    h1MinShare: number;
    h1HoldS: number;
    windowS: number;
    minWindowS: number;
    evalEveryS: number;
    h2MinDeg: number;
    h2Sigmas: number;
    h2Evals: number;
    h3Percentile: number;
    h3MaxRatio: number;
    h4WindowS: number;
    h4MaxDeg: number;
    recoverS: number;
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
    /**
     * C6 round 1 (review-C6 C6-2): the population-prior fallback, deep closures only, BEFORE any EAR reference
     * exists (a drive that has not yet moved at the admission speed, a queue, a stop). Absolute EARs: closed below
     * closedEar, open above openEar (or back above closedEar for reopenMs: a low open eye, reading or squinting, is no
     * closure); F1–F3 count DEEP time only (a continuous run below deepEar; C6 round 2, review-C6 R1-P), F1 at
     * f1ClosedS. It feeds no fatigue statistic (no openness, no blink) and no calibration, and is replaced as soon as a
     * reference exists. Device item D-C6-3 tunes the thresholds.
     */
    prior: { closedEar: number; openEar: number; deepEar: number; f1ClosedS: number; reopenMs: number };
    /**
     * The minimum rule speeds of F1–F3: 0 since Task C2 (rev4 §2.1.7, the user's rule: the sleep family runs at
     * every speed while the gate is open). Kept as keys: a negative control restores them.
     */
    f1: { closedS: number; lookDownClosedS: number; minSpeedKmh: number };
    /**
     * C7 round 1 (review-C7 C7-4): an F event raised while moving in an episode never deep (openness below
     * lookDownClosedBelow) for this long is marked shallow: delivered, but it feeds no fatigue statistic.
     */
    shallowDeepMs: number;
    /**
     * C7 round 3 (review-C7 R2-S): deep-only counting (latched or stopped) bridges a non-deep stretch of up to this
     * long while the eye stays closed: a real closed lid's EAR noise flickers over 0.15 frame by frame.
     */
    deepBridgeMs: number;
    /**
     * C7 round 5 (review-C7 R4-C), its own key since round 6: below this rule speed every closure counts deep-only, as
     * at a stop (the crawl band, where the capture runs 5 fps); at or above it an unlatched shallow closure is the
     * eyes_on_road alert (R4-T).
     */
    deepOnlyBelowKmh: number;
    /**
     * Task C7 (rev4 §2.3.6 S1; review-C2 §3, R-a and R-b): the looking-down latch. At a closure's onset it reads the
     * open-eye frames of lookbackMs before it. R-a: the unsmoothed gaze reads "down" on reliable-eye frames; at
     * ≥ rawGuardMinFps two raw frames within rawGuardMs are needed.
     * C7 round 1 (review-C7): every latch clears on evidence of the kind that set it (C7-1). A HEAD-set latch (the
     * head fallback) clears when the head pitch is above clearPitchDeg for clearHoldMs. A GAZE-set latch (the gaze
     * or R-a) clears on a reliable raw frame above lookDownRelPitchDeg + gazeClearMarginDeg, or the head risen
     * headRiseDeg above its onset pitch for clearHoldMs. R-b (STOPPED only; C7-2, relative): the head falling
     * stopDipDeg below its own median over the stopPreOnsetS before onset, within the first stopSetWindowS; it clears
     * when the head is back within stopReturnDeg of that median for clearHoldMs.
     */
    latch: {
      lookbackMs: number;
      /** C7 round 4: …and at least this many frame intervals (at 5 fps, 800 ms: a lagging lid crosses closedBelow 3–4 frames after the saccade) */
      lookbackFrames: number;
      clearPitchDeg: number;
      clearHoldMs: number;
      rawGuardMs: number;
      rawGuardMinFps: number;
      /**
       * T7 pre-ruling (review-C6 Round 2): ONE raw frame sets the latch when its pitch is below
       * lookDownRelPitchDeg − rawSingleSigmas·σ̂ (−27° at σ̂ 4°), every usable eye is reliable on it, and the two
       * eyes' raw pitches agree within rawEyeAgreeDeg (a descending lid's partly covered iris biases one eye).
       */
      rawSingleSigmas: number;
      rawEyeAgreeDeg: number;
      gazeClearMarginDeg: number;
      headRiseDeg: number;
      stopDipDeg: number;
      stopReturnDeg: number;
      stopPreOnsetS: number;
      stopSetWindowS: number;
    };
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
    /**
     * Task C2 (rev4 §2.1.9, rev5 §4.4, U-14): what the sleep events raised while STOPPED feed, beyond the Tier 3
     * sound, the log and the summary count (always). 'none' (U-14 a, the default): neither F4's fatigue floor
     * nor the trip score; 'long_and_nod': only F2/F3 episodes (closures of 3 s or more) and microsleep_nod;
     * 'all': everything, as moving events.
     */
    stopEventsFeed: StopEventsFeed;
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
    /**
     * Task C6 (rev2 §2.3.5): when the EAR baseline moves more than blinkRelearnFrac from the one the blink rows
     * were learned under, longBlinks and blinkDuration are sparse for blinkRelearnS of observed time and re-learned.
     */
    blinkRelearnFrac: number;
    blinkRelearnS: number;
    /**
     * Task C6 (rev2 §2.3.7): the fatigue evidence gate's fatigue clauses: PERCLOS over gatePerclosWindowS ≥
     * gatePerclos (with perclosMinTrackingS observed), or ≥ gateLongBlinks long blinks in gateLongBlinkWindowS.
     */
    gatePerclos: number;
    gatePerclosWindowS: number;
    gateLongBlinks: number;
    gateLongBlinkWindowS: number;
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
    emaWithinFrac: 0.5,
    emaWithinMinDeg: 3,
    emaMaxDegPerMin: 0.5,
    voidS: 30,
    baselines: {
      buckets: 5,
      readEveryS: 30,
      minReadS: 20,
      maxYawDeg: 25,
      maxPitchRelDeg: 15,
      minOpenness: 0.6,
      earUpPctPerMin: 5,
      earUpCapFrac: 1.4,
      earFloorFrac: 0.85,
      appearanceLumaFrac: 0.25,
      appearanceIodFrac: 0.05,
      appearanceHoldS: 10,
      checkS: 10,
      explainTol: 0.05,
      unexplainedHoldS: 600,
      earNoiseMaxSd: 0.012,
      lowRatio: 0.9,
      lowHoldS: 60,
      h5Lo: 0.8,
      h5Hi: 1.25,
      h5HoldS: 60,
      h5CorroborateS: 600,
      lumaEarTable: [
        [0.25, 0.7],
        [0.5, 0.8],
        [1, 1],
        [2, 1.1],
      ],
      iodEarPerFrac: 0.5,
      marUpPctPerMin: 3,
      marUpCap10MinFrac: 0.2,
      marDownPctPerMin: 5,
      talkMarFactor: 1.5,
      yawnBlockS: 300,
    },
    rolling: { windowS: 60, everyS: 30, rateDegPerMin: 3, minShiftDeg: 0.5, maxPitchDownDeg: 2, screenExtraDeg: 12 },
    slow: { persistS: 300, maxShiftDeg: 12.5, scanExcursionsPerMin: 2, excursionMinDeg: 15, excursionReturnS: 3, returnFixationMs: 300, returnShare: 0.8, returnMinCount: 12, returnMinCountRolling: 12, excessMax: 0.15 },
    bumpHalfWindowS: 5,
    bumpAngleDeg: 6,
    bumpBoxShift: 0.08,
    bumpIodFrac: 0.12,
    bumpSpanS: 2,
    signatureS: 10,
    resumeCompareS: 5,
    warmRetryS: 300,
    legacyEarMaxLowerFrac: 0.08,
    longSearchS: 30,
    resumeTolerance: { yawDeg: 4, pitchDeg: 4, rollDeg: 3, box: 0.05, iodFrac: 0.1 },
    driverChange: { iodFrac: 0.15, box: 0.15 },
    posture: {
      boxShiftC: 0.03,
      iodFracC: 0.05,
      halfWindowS: 5,
      spanS: 4,
      slumpPitchDeg: 3,
      onsetWidenMaxS: 15,
      boxPerDegPrior: 0.003,
      fitRidgeDeg2: 20,
      fitDecayS: 600,
      fitUncertainty: 1.5,
      slumpHoldS: 30,
      slumpYawDeg: 5,
      slumpOnRoadShare: 0.7,
      candidateCameraMarginDeg: 4,
      candidateNonDrivingShare: 0.3,
      revertWindowS: 30,
      fitMinSamples: 150,
      searchS: 8,
      searchMaxS: 60,
      searchCurveRateDegS: 2,
      searchCapS: 300,
      fatigueCommitPitchDeg: 3,
      searchMaxDeg: 20,
      peakedRatio: 0.8,
      commitS: 60,
      revertS: 30,
      undecidedMaxS: 300,
      probationS: 300,
      probationRevertS: 60,
      smallShiftSigmas: 1.2,
      vacatedRatio: 0.5,
      unimodalRatio: 0.3,
      evalEveryS: 5,
      demoteBoxC: 0.05,
      demoteIodFracC: 0.06,
    },
    stops: { swapLostS: 3, swapTrackS: 5, interimFloor: 0.85, interimNearDeg: 15, cameraStepBoxPerDeg: 0.015, cameraStepTolerance: 0.3 },
    opennessCheckS: 10,
    opennessCheckMinRelPitchDeg: -15,
    opennessRange: [0.6, 1.4],
    startOpennessRange: [0.6, 1.15],
    startMarRange: [0.7, 1.4],
    seed: { admitMinSpeedKmh: 30, windowS: 8, windowMaxObservedS: 60, ringMinDeg: 4, ringSigmas: 1.3, peakFrac: 0.8, agreeMinDeg: 3, agreeSE: 2.5, pairMinDeg: 1.5, pairSE: 2, curveRateDegS: 2, disputeMaxS: 60 },
    save: { healthyS: 600, gateClearS: 600 },
    seedWindowS: 3,
    seedMinS: 2,
    seedMaxSdDeg: 3,
    warmupS: 60,
  },
  health: {
    h1TauS: 60,
    h1MinShare: 0.5,
    h1HoldS: 30,
    windowS: 30,
    minWindowS: 20,
    evalEveryS: 5,
    h2MinDeg: 4,
    h2Sigmas: 1.5,
    h2Evals: 2,
    h3Percentile: 0.85,
    h3MaxRatio: 1.5,
    h4WindowS: 30,
    h4MaxDeg: 6,
    recoverS: 60,
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
    prior: { closedEar: 0.06, openEar: 0.12, deepEar: 0.045, f1ClosedS: 1.5, reopenMs: 500 },
    f1: { closedS: 1.0, lookDownClosedS: 1.5, minSpeedKmh: 0 },
    shallowDeepMs: 300,
    deepBridgeMs: 300,
    deepOnlyBelowKmh: 20,
    latch: { lookbackMs: 500, lookbackFrames: 4, clearPitchDeg: -5, clearHoldMs: 300, rawGuardMs: 300, rawGuardMinFps: 10, rawSingleSigmas: 3, rawEyeAgreeDeg: 8, gazeClearMarginDeg: 3, headRiseDeg: 3, stopDipDeg: 3, stopReturnDeg: 1.5, stopPreOnsetS: 1.0, stopSetWindowS: 1.0 },
    f2: { closedS: 3.0, minSpeedKmh: 0 },
    f3: { closedS: 6.0, noOnRoadS: 3.0, minSpeedKmh: 0 },
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
    // Task C2 (rev4 §2.1.7): microsleep_nod at every speed (was 20). A nod's fatigue count is unchanged
    // (every nod while moving; the engine freezes nod statistics while STOPPED).
    minSpeedKmh: 0,
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
    stopEventsFeed: 'none',
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
    blinkRelearnFrac: 0.1,
    blinkRelearnS: 300,
    gatePerclos: 0.08,
    gatePerclosWindowS: 60,
    gateLongBlinks: 2,
    gateLongBlinkWindowS: 300,
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
  /^closure\.latch\.clearPitchDeg$/,
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
  // Task C5: the EMA gate, the rolling and slow paths.
  if (!(c.calibration.emaWithinFrac > 0 && c.calibration.emaWithinFrac <= 1)) bad('calibration.emaWithinFrac', 'must lie in (0, 1]');
  const ro = c.calibration.rolling;
  if (!(ro.rateDegPerMin > c.calibration.emaMaxDegPerMin)) bad('calibration.rolling.rateDegPerMin', 'must exceed emaMaxDegPerMin');
  if (!(ro.windowS >= 2 * ro.everyS)) bad('calibration.rolling.windowS', 'must be ≥ 2 × everyS');
  if (!(c.calibration.slow.maxShiftDeg > c.calibration.radiusMinDeg)) bad('calibration.slow.maxShiftDeg', 'must exceed radiusMinDeg');
  if (!(c.calibration.slow.returnShare > 0.5 && c.calibration.slow.returnShare <= 1)) bad('calibration.slow.returnShare', 'must lie in (0.5, 1]');
  if (!(c.calibration.slow.returnMinCount >= 1 && c.calibration.slow.returnMinCountRolling >= 1)) bad('calibration.slow.returnMinCount', 'must be ≥ 1');
  if (!(ro.minShiftDeg > 0)) bad('calibration.rolling.minShiftDeg', 'must be > 0');
  if (!(c.calibration.voidS > 0)) bad('calibration.voidS', 'must be > 0');
  if (!(c.calibration.posture.searchCapS >= c.calibration.posture.searchMaxS)) bad('calibration.posture.searchCapS', 'must be ≥ searchMaxS');
  if (!(c.calibration.posture.searchCurveRateDegS > 0)) bad('calibration.posture.searchCurveRateDegS', 'must be > 0');
  if (!(c.calibration.posture.fatigueCommitPitchDeg > 0)) bad('calibration.posture.fatigueCommitPitchDeg', 'must be > 0');
  // Task C6: the baselines and the fatigue gate's clauses.
  const bl = c.calibration.baselines;
  if (!(bl.earFloorFrac >= 0.75 && bl.earFloorFrac <= 0.95)) bad('calibration.baselines.earFloorFrac', 'must lie in [0.75, 0.95]');
  if (!(bl.earUpCapFrac > 1)) bad('calibration.baselines.earUpCapFrac', 'must exceed 1');
  if (!(bl.lowRatio > 0 && bl.lowRatio < 1)) bad('calibration.baselines.lowRatio', 'must lie in (0, 1)');
  if (!(bl.earNoiseMaxSd > 0 && bl.earNoiseMaxSd < 0.05)) bad('calibration.baselines.earNoiseMaxSd', 'must lie in (0, 0.05)');
  if (!(c.calibration.legacyEarMaxLowerFrac >= 0 && c.calibration.legacyEarMaxLowerFrac < 1 - bl.earFloorFrac)) bad('calibration.legacyEarMaxLowerFrac', 'must lie in [0, 1 − earFloorFrac)');
  if (!(bl.appearanceLumaFrac > 0 && bl.appearanceLumaFrac < 1)) bad('calibration.baselines.appearanceLumaFrac', 'must lie in (0, 1)');
  const lt = bl.lumaEarTable;
  if (!(lt.length >= 2 && lt.every((row, i) => i === 0 || row[0] > lt[i - 1]![0]))) bad('calibration.baselines.lumaEarTable', 'must have ≥ 2 rows in ascending order');
  if (!(c.fatigue.gatePerclos > 0 && c.fatigue.gatePerclos < 1)) bad('fatigue.gatePerclos', 'must lie in (0, 1)');
  if (!(c.fatigue.blinkRelearnFrac > 0)) bad('fatigue.blinkRelearnFrac', 'must be > 0');
  // Task C4: posture and the across-stop checks.
  const po = c.calibration.posture;
  if (!(po.boxShiftC < c.calibration.bumpBoxShift && po.iodFracC < c.calibration.bumpIodFrac)) bad('calibration.posture.boxShiftC', "posture thresholds must lie below the bump's");
  if (!(po.spanS > 0 && po.spanS < 2 * po.halfWindowS)) bad('calibration.posture.spanS', 'must be > 0 and shorter than the window');
  if (!(po.commitS >= 30)) bad('calibration.posture.commitS', 'must be ≥ 30');
  if (!(po.vacatedRatio > 0 && po.vacatedRatio < 1)) bad('calibration.posture.vacatedRatio', 'must lie in (0, 1)');
  if (!(po.revertS < po.undecidedMaxS && po.searchMaxS < po.undecidedMaxS)) bad('calibration.posture.undecidedMaxS', 'must exceed revertS and searchMaxS');
  if (!(po.demoteBoxC >= po.boxShiftC && po.demoteIodFracC >= po.iodFracC)) bad('calibration.posture.demoteBoxC', 'must be ≥ the step thresholds');
  const st = c.calibration.stops;
  if (!(st.interimFloor > 0 && st.interimFloor <= 1)) bad('calibration.stops.interimFloor', 'must lie in (0, 1]');
  if (!(st.swapLostS >= 1)) bad('calibration.stops.swapLostS', 'must be ≥ 1');
  if (!(st.swapTrackS >= 3)) bad('calibration.stops.swapTrackS', 'must be ≥ 3');
  if (!STOP_EVENTS_FEEDS.includes(c.fatigue.stopEventsFeed)) bad('fatigue.stopEventsFeed', `must be one of ${STOP_EVENTS_FEEDS.join(', ')}`);
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
  ordered('calibration.startOpennessRange', c.calibration.startOpennessRange);
  ordered('calibration.startMarRange', c.calibration.startMarRange);
  // C8 round 1 (C8-1): the warm start's retries.
  if (!(c.calibration.warmRetryS > c.calibration.resumeCompareS)) bad('calibration.warmRetryS', 'must be > resumeCompareS');
  // Task C8: seed verification.
  const sv = c.calibration.seed;
  if (!(sv.windowS > 0 && sv.windowS < sv.windowMaxObservedS)) bad('calibration.seed.windowS', 'must be in (0, windowMaxObservedS)');
  if (!(sv.peakFrac > 0 && sv.peakFrac <= 1)) bad('calibration.seed.peakFrac', 'must be in (0, 1]');
  if (!(sv.agreeMinDeg < c.calibration.radiusMinDeg)) bad('calibration.seed.agreeMinDeg', 'must be < radiusMinDeg');
  if (!(sv.pairMinDeg > 0 && sv.pairMinDeg <= sv.agreeMinDeg)) bad('calibration.seed.pairMinDeg', 'must be in (0, agreeMinDeg]');
  if (!(sv.admitMinSpeedKmh >= c.calibration.admitMinSpeedKmh)) bad('calibration.seed.admitMinSpeedKmh', 'must be ≥ admitMinSpeedKmh');
  if (!(sv.disputeMaxS >= sv.windowS)) bad('calibration.seed.disputeMaxS', 'must be ≥ windowS');
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

  // Task C7: health.
  const he = c.health;
  if (!(he.h1MinShare > 0 && he.h1MinShare < 1)) bad('health.h1MinShare', 'must be in (0, 1)');
  if (!(he.minWindowS < he.windowS)) bad('health.minWindowS', 'must be < windowS');
  if (!(he.evalEveryS > 0 && he.evalEveryS <= he.windowS)) bad('health.evalEveryS', 'must be in (0, windowS]');
  if (!Number.isInteger(he.h2Evals) || he.h2Evals < 1) bad('health.h2Evals', 'must be a positive integer');
  if (!(he.h3Percentile > 0 && he.h3Percentile < 1)) bad('health.h3Percentile', 'must be in (0, 1)');
  if (!(he.h3MaxRatio > 1)) bad('health.h3MaxRatio', 'must be > 1');

  // Closure.
  const cl = c.closure;
  if (!(cl.closedBelow < cl.openAbove)) bad('closure.closedBelow', 'must be < openAbove (hysteresis)');
  if (!(cl.lookDownClosedBelow <= cl.closedBelow)) bad('closure.lookDownClosedBelow', 'must be ≤ closedBelow');
  // Task C7 (review-C2 round 1): the latch's constants.
  const la = cl.latch;
  if (!(la.lookbackMs >= 200)) bad('closure.latch.lookbackMs', 'must be ≥ 200 ms (one frame at 5 fps)');
  if (!(la.lookbackFrames >= 1 && la.lookbackFrames <= 5)) bad('closure.latch.lookbackFrames', 'must be in [1, 5]');
  // C7 round 1 (C7-2): R-b's set and clear share the pre-onset median, so the clear band must sit inside the set.
  if (!(cl.shallowDeepMs > 0 && cl.shallowDeepMs < cl.f1.closedS * 1000)) bad('closure.shallowDeepMs', 'must be in (0, f1.closedS)');
  if (!(cl.deepBridgeMs > 0 && cl.deepBridgeMs < cl.f1.closedS * 1000)) bad('closure.deepBridgeMs', 'must be in (0, f1.closedS)');
  if (!(cl.deepOnlyBelowKmh >= 10 && cl.deepOnlyBelowKmh <= c.distraction.logOnlyBelowKmh)) bad('closure.deepOnlyBelowKmh', 'must be in [10, distraction.logOnlyBelowKmh]');
  if (!(la.stopReturnDeg > 0 && la.stopReturnDeg < la.stopDipDeg)) bad('closure.latch.stopReturnDeg', 'must be in (0, stopDipDeg) (no head angle both sets and clears)');
  if (!(la.stopPreOnsetS >= 0.2)) bad('closure.latch.stopPreOnsetS', 'must be ≥ 0.2 s (one frame at 5 fps)');
  if (!(la.gazeClearMarginDeg > 0 && la.headRiseDeg > 0)) bad('closure.latch.gazeClearMarginDeg', 'the gaze clears must be > 0');
  if (!(la.clearHoldMs > 0)) bad('closure.latch.clearHoldMs', 'must be > 0');
  if (!(la.rawSingleSigmas >= 2)) bad('closure.latch.rawSingleSigmas', 'must be ≥ 2 (a single frame must lie far beyond noise)');
  if (!(la.rawEyeAgreeDeg > 0)) bad('closure.latch.rawEyeAgreeDeg', 'must be > 0');
  if (!(la.stopSetWindowS <= cl.f1.closedS)) bad('closure.latch.stopSetWindowS', 'must be ≤ f1.closedS (R-b acts before F1 can fire)');
  if (!(la.clearPitchDeg < 0 && la.clearPitchDeg > cl.lookDownRelPitchDeg)) bad('closure.latch.clearPitchDeg', 'must lie between lookDownRelPitchDeg and 0');
  if (!(cl.f1.closedS < cl.f2.closedS && cl.f2.closedS < cl.f3.closedS)) bad('closure.f1', 'F1 < F2 < F3 closure times');
  if (!(cl.f1.lookDownClosedS >= cl.f1.closedS)) bad('closure.f1.lookDownClosedS', 'must be ≥ f1.closedS');
  // C6 round 1 (C6-2): the prior's absolute EARs, deep only (below any plausible open eye).
  const pr = cl.prior;
  if (!(pr.deepEar > 0 && pr.deepEar < pr.closedEar)) bad('closure.prior.deepEar', 'must be in (0, closedEar)');
  if (!(pr.closedEar < pr.openEar && pr.openEar < 0.2)) bad('closure.prior.closedEar', 'must satisfy 0 < closedEar < openEar < 0.2');
  if (!(pr.f1ClosedS >= cl.f1.closedS && pr.f1ClosedS < cl.f2.closedS)) bad('closure.prior.f1ClosedS', 'must be in [f1.closedS, f2.closedS)');
  if (!(pr.reopenMs >= 200 && pr.reopenMs < pr.f1ClosedS * 1000)) bad('closure.prior.reopenMs', 'must be in [200 ms, f1ClosedS)');

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
