// One FeatureRow per second from the second's IMU samples, its last fix and the phone state (R1,
// R2). This is the reference the Swift and Kotlin extractors port line for line; README.md
// §Algorithm is the same procedure in prose, and the golden vectors pin its output.
import { checkReset, initialAlignmentState, reproject, updateAlignment } from './alignment';
import {
  G_MPS2,
  GNSS_MAX_AGE_S,
  GNSS_MAX_HACC_M,
  IMU_MAX_DT_S,
  MIN_IMU_SAMPLES,
  NO_FIX_HACC_M,
  SMOOTH_SAMPLES,
  UNKNOWN,
} from './constants';
import { frameFree } from './handling';
import { probe } from './probe';
import type { ExtractState, ExtractedRow, FixSample, ImuSample, PhoneSample } from './types';
import { add, clamp, cross, dot, normalize, reject, scale, type Vec3 } from './vec';

export const initialExtractState = (): ExtractState => ({
  lastFix: null,
  prevValidFix: null,
  lastImuT: null,
  hTail: [],
  prevLon: null,
  alignment: initialAlignmentState(),
});

const known = (x: number): number => (x >= 0 ? x : UNKNOWN);

interface Gnss {
  fields: Pick<
    ExtractedRow,
    'lat' | 'lng' | 'hAcc' | 'speed' | 'speedAcc' | 'course' | 'alt' | 'gnssValid'
  >;
  lastFix: ExtractState['lastFix'];
  prevValidFix: ExtractState['prevValidFix'];
  /** signed ΔvGNSS/Δt in g between this and the previous valid fix, or null */
  dvG: number | null;
}

function gnss(fix: FixSample | null, ts: number, state: ExtractState): Gnss {
  if (fix === null) {
    const p = state.lastFix;
    return {
      fields: {
        lat: p ? p.lat : 0,
        lng: p ? p.lng : 0,
        alt: p ? p.alt : 0,
        hAcc: NO_FIX_HACC_M,
        speed: UNKNOWN,
        speedAcc: UNKNOWN,
        course: UNKNOWN,
        gnssValid: false,
      },
      lastFix: p,
      prevValidFix: null,
      dvG: null,
    };
  }
  const hAcc = fix.hAcc >= 0 ? fix.hAcc : NO_FIX_HACC_M;
  const age = (ts - fix.t) / 1000;
  if (fix.hAcc >= 0) probe('GNSS_MAX_HACC_M', fix.hAcc, GNSS_MAX_HACC_M);
  probe('GNSS_MAX_AGE_S', age, GNSS_MAX_AGE_S);
  const gnssValid = fix.hAcc >= 0 && fix.hAcc <= GNSS_MAX_HACC_M && age <= GNSS_MAX_AGE_S;
  const speed = known(fix.speed);
  let dvG: number | null = null;
  let prevValidFix: Gnss['prevValidFix'] = null;
  if (gnssValid && speed >= 0) {
    const prev = state.prevValidFix;
    if (prev && fix.t > prev.t) dvG = (speed - prev.speed) / ((fix.t - prev.t) / 1000) / G_MPS2;
    prevValidFix = { t: fix.t, speed };
  }
  return {
    fields: {
      lat: fix.lat,
      lng: fix.lng,
      alt: fix.alt,
      hAcc,
      speed,
      speedAcc: known(fix.speedAcc),
      course: known(fix.course),
      gnssValid,
    },
    lastFix: { lat: fix.lat, lng: fix.lng, alt: fix.alt },
    prevValidFix,
    dvG,
  };
}

const IMU_ABSENT = {
  aLonMax: 0,
  aLonMin: 0,
  aLatMax: 0,
  aLatMin: 0,
  yawRateMax: 0,
  jerkMax: 0,
  gravityStability: 0,
  orientationDelta: 0,
  handlingScore: 0,
} as const;

/**
 * @param imu the samples with t in (tsMs − 1000, tsMs], oldest first
 * @param fix the last fix that ARRIVED during the second, or null if none did
 * @param tsMs the end of the second, epoch ms (rounded to an integer for the row)
 */
export function extractSecond(
  imu: readonly ImuSample[],
  fix: FixSample | null,
  phone: PhoneSample,
  tsMs: number,
  state: ExtractState
): { row: ExtractedRow; state: ExtractState } {
  const ts = Math.round(tsMs);
  const g = gnss(fix, ts, state);
  const phoneFields = {
    locked: phone.locked,
    screenOn: phone.screenOn,
    appForeground: phone.appForeground,
  };

  // ——— IMU absent (R2) ———
  if (imu.length < MIN_IMU_SAMPLES) {
    const last = imu[imu.length - 1];
    return {
      row: { ts, ...g.fields, ...IMU_ABSENT, ...phoneFields },
      state: {
        lastFix: g.lastFix,
        prevValidFix: g.prevValidFix,
        lastImuT: last ? last.t : state.lastImuT,
        hTail: [],
        prevLon: null,
        alignment: state.alignment,
      },
    };
  }

  // ——— per-sample basics ———
  const n = imu.length;
  const gHat: Vec3[] = [];
  const dt: number[] = [];
  const h: Vec3[] = [];
  let gSum: Vec3 = [0, 0, 0];
  let tPrev = state.lastImuT;
  let hSum: Vec3 = [0, 0, 0];
  for (const s of imu) {
    const gi = normalize(s.g);
    gHat.push(gi);
    gSum = add(gSum, gi);
    dt.push(tPrev === null ? 0 : clamp((s.t - tPrev) / 1000, 0, IMU_MAX_DT_S));
    tPrev = s.t;
    const hi = reject(s.ua, gi);
    h.push(hi);
    hSum = add(hSum, hi);
  }
  const gMean = normalize(gSum);
  const free = frameFree(imu, gHat, gMean, dt);

  // ——— frame: reset → reproject → update ———
  const r = checkReset(state.alignment, gMean, free.orientationDelta);
  let alignment = reproject(r.state, gMean);
  if (!r.reset) alignment = updateAlignment(alignment, scale(hSum, 1 / n), gMean, g.dvG);

  // ——— frame-dependent extremes ———
  const window: Vec3[] = [...state.hTail];
  let aLonMax = 0;
  let aLonMin = 0;
  let aLatMax = 0;
  let aLatMin = 0;
  let jerkMax = 0;
  let prevLon: ExtractState['prevLon'] = null;
  const f = alignment.aligned ? alignment.f : null;
  if (f !== null) {
    const l = normalize(cross(f, gMean)); // left, whatever sign convention ua uses (README §Frames)
    aLonMax = -Infinity;
    aLonMin = Infinity;
    aLatMax = -Infinity;
    aLatMin = Infinity;
    prevLon = state.prevLon;
    for (let i = 0; i < n; i++) {
      window.push(h[i]!);
      if (window.length > SMOOTH_SAMPLES) window.shift();
      let sm: Vec3 = [0, 0, 0];
      for (const v of window) sm = add(sm, v);
      sm = scale(sm, 1 / window.length);
      const lon = dot(sm, f);
      const lat = dot(sm, l);
      if (lon > aLonMax) aLonMax = lon;
      if (lon < aLonMin) aLonMin = lon;
      if (lat > aLatMax) aLatMax = lat;
      if (lat < aLatMin) aLatMin = lat;
      const di = dt[i]!;
      if (prevLon !== null && di > 0) {
        const j = Math.abs(lon - prevLon.v) / di;
        if (j > jerkMax) jerkMax = j;
      }
      prevLon = { t: imu[i]!.t, v: lon };
    }
  } else {
    for (const v of h) {
      window.push(v);
      if (window.length > SMOOTH_SAMPLES) window.shift();
    }
  }

  return {
    row: {
      ts,
      ...g.fields,
      aLonMax,
      aLonMin,
      aLatMax,
      aLatMin,
      yawRateMax: free.yawRateMax,
      jerkMax,
      gravityStability: free.gravityStability,
      orientationDelta: free.orientationDelta,
      handlingScore: free.handlingScore,
      ...phoneFields,
    },
    state: {
      lastFix: g.lastFix,
      prevValidFix: g.prevValidFix,
      lastImuT: imu[n - 1]!.t,
      hTail: window.slice(-(SMOOTH_SAMPLES - 1)),
      prevLon,
      alignment,
    },
  };
}
