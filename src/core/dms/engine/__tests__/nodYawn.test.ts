// Nods (plan §M6, C-15, rev1 I3) and yawns (§M6, C-23, rev1 I4 and m7).
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { createNodDetector, type NodInput } from '../nod';
import { createYawnDetector, speechRatio, type YawnInput } from '../yawn';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

/** A nod stream at 15 fps from pitch(t) and openness(t) (relative head pitch, degrees). */
function nods(pitch: (t: number) => number, openness: (t: number) => number | null, seconds = 6, speed = 60, gap: { lost: (t: number) => boolean; bridged?: boolean } | null = null) {
  const d = createNodDetector(C);
  const kinds: string[] = [];
  for (let i = 0; i <= seconds * 15; i++) {
    const t = i / 15;
    const lost = gap?.lost(t) ?? false;
    const x: NodInput = lost
      ? { tMs: t * 1000, quality: 'lost', relPitchDeg: null, openness: null, ruleSpeedKmh: speed, closureBridged: gap?.bridged ?? false }
      : { tMs: t * 1000, quality: 'tracking', relPitchDeg: pitch(t), openness: openness(t), ruleSpeedKmh: speed };
    kinds.push(...d.onFrame(x).map((e) => e.kind));
  }
  return kinds;
}
/** Level at 0 until 1 s, down to −depth over `dropS`, held `holdS`, back up over `upS`. */
const profile = (depth: number, dropS: number, holdS: number, upS: number) => (t: number) => {
  const t0 = 1;
  if (t < t0) return 0;
  if (t < t0 + dropS) return (-depth * (t - t0)) / dropS;
  if (t < t0 + dropS + holdS) return -depth;
  if (t < t0 + dropS + holdS + upS) return -depth + (depth * (t - t0 - dropS - holdS)) / upS;
  return 0;
};

describe('nods', () => {
  test('the geometry: from level, ≥ 15° down within 1 s with openness < 0.5, back up faster than 30°/s within 2 s → nod', () => {
    expect(nods(profile(20, 0.6, 0.3, 0.4), () => 0.3)).toEqual(['nod']);
  });
  test('a slow look-down with open eyes is not a nod', () => {
    expect(nods(profile(20, 2.0, 1.0, 2.0), () => 1)).toEqual([]);
    expect(nods(profile(20, 0.6, 0.3, 0.4), () => 1)).toEqual([]); // fast but eyes open
    expect(nods(profile(20, 0.6, 0.3, 1.5), () => 0.3)).toEqual([]); // the recovery is too slow (13°/s)
  });
  test('a nod with openness < 0.15 held 0.5 s during it → microsleep_nod (rev1 I3, C-15)', () => {
    const lidsShut = (t: number) => (t >= 1.2 && t < 1.8 ? 0.1 : 0.3);
    expect(nods(profile(20, 0.6, 0.3, 0.4), lidsShut)).toEqual(['microsleep_nod']);
  });
  test('a lap glance with lids at 0.25 and a fast snap back is at most a nod, never microsleep_nod', () => {
    expect(nods(profile(25, 0.5, 0.5, 0.3), () => 0.25)).toEqual(['nod']);
  });
  test('T9 r1 m2: one blink frame in a lap glance is not "while openness < 0.5": every known frame of the drop must be', () => {
    expect(nods(profile(20, 0.6, 0.3, 0.4), (t) => (t >= 1.3 && t < 1.37 ? 0.2 : 1))).toEqual([]);
  });
  test('C-26: a nod whose depth frames are LOST for 0.5 s, then a return up → nod (the speed across the gap)', () => {
    expect(nods(profile(20, 0.6, 0.3, 0.4), () => 0.3, 6, 60, { lost: (t) => t >= 1.65 && t < 2.15 })).toEqual(['nod']);
  });
  test('C-26: the openness hold counts a LOST gap only when the closure was bridged', () => {
    const lids = (t: number) => (t >= 1.2 && t < 1.9 ? 0.1 : 0.3);
    const gap = (t: number) => t >= 1.4 && t < 1.75;
    expect(nods(profile(20, 0.6, 0.3, 0.4), lids, 6, 60, { lost: gap, bridged: true })).toEqual(['microsleep_nod']);
    expect(nods(profile(20, 0.6, 0.3, 0.4), lids, 6, 60, { lost: gap, bridged: false })).toEqual(['nod']);
  });
  test('T12 R1-m1: a frame gap does not count as deep-lid time (unless bridged)', () => {
    // 15 fps; the frames in (1.28 s, 1.8 s) are missing (a 0.53 s gap); lids at 0.1 for about 0.1 s on each
    // side of it. The depth is seen at 1.8 s, the recovery after 1.9 s.
    const d = createNodDetector(C);
    const kinds: string[] = [];
    let prevT = -1;
    const pitch = profile(20, 0.6, 0.3, 0.4);
    for (let i = 0; i <= 6 * 15; i++) {
      const t = i / 15;
      if (t > 1.28 && t < 1.8) continue;
      const lids = (t >= 1.2 && t <= 1.28) || (t >= 1.8 && t < 1.9) ? 0.1 : 0.3;
      const gap = prevT >= 0 && t - prevT > 0.5;
      prevT = t;
      kinds.push(...d.onFrame({ tMs: t * 1000, quality: 'tracking', relPitchDeg: pitch(t), openness: lids, ruleSpeedKmh: 60, gap }).map((e) => e.kind));
    }
    expect(kinds).toEqual(['nod']);
  });
  test('microsleep_nod needs 20 km/h; below it the nod is still counted', () => {
    const lidsShut = (t: number) => (t >= 1.2 && t < 1.8 ? 0.1 : 0.3);
    expect(nods(profile(20, 0.6, 0.3, 0.4), lidsShut, 6, 15)).toEqual(['nod']);
  });
});

/** A yawn stream at `fps`: openness(t) = MAR / neutral, with the mouth width ratio w(t). */
function yawns(mar: (t: number) => number, opts: { fps?: number; seconds?: number; width?: (t: number) => number; neutralMar?: number; neutralW?: number } = {}) {
  const fps = opts.fps ?? 15;
  const d = createYawnDetector(C);
  const kinds: string[] = [];
  for (let i = 0; i <= (opts.seconds ?? 8) * fps; i++) {
    const t = i / fps;
    const x: YawnInput = {
      tMs: t * 1000,
      quality: 'tracking',
      mar: mar(t),
      mouthW: (opts.width ?? (() => 0.9))(t),
      neutralMar: opts.neutralMar ?? 0.1,
      neutralMouthW: opts.neutralW ?? 0.9,
      fps,
    };
    kinds.push(...d.onFrame(x).map((e) => e.kind));
  }
  return kinds;
}
/** MAR: neutral 0.1, rising over `riseS` to `peak`, held `holdS` (a gentle hump), falling over `fallS`. */
const yawnMar = (peak: number, riseS: number, holdS: number, fallS: number) => (t: number) => {
  const t0 = 1;
  if (t < t0) return 0.1;
  if (t < t0 + riseS) return 0.1 + ((peak - 0.1) * (t - t0)) / riseS;
  if (t < t0 + riseS + holdS) return peak * (1 + 0.05 * Math.sin((Math.PI * (t - t0 - riseS)) / holdS));
  if (t < t0 + riseS + holdS + fallS) return peak - ((peak - 0.1) * (t - t0 - riseS - holdS)) / fallS;
  return 0.1;
};

describe('yawns', () => {
  test('a slow yawn held 2 s at openness ≥ 2.5 and MAR ≥ 0.35 passes', () => {
    expect(yawns(yawnMar(0.4, 0.8, 2.2, 0.8))).toEqual(['yawn']);
  });
  test('held 1.9 s fails', () => {
    expect(yawns(yawnMar(0.4, 0.8, 1.7, 0.8))).toEqual([]);
  });
  test('a rise faster than 0.3 s from 1.5 to 2.5 fails', () => {
    expect(yawns(yawnMar(0.4, 0.15, 2.4, 0.8))).toEqual([]);
  });
  // A talking amplitude of 0.04 keeps the mouth above MAR 0.35 and openness 2.5 throughout, so only the
  // speech test can reject it (an earlier draft's 0.12 dipped under 0.35 and was rejected by the
  // absolute-MAR hold instead, which hid a missing speech test). One test per case (T9 review m3).
  const talk = (hz: number) => (t: number) => {
    const base = yawnMar(0.4, 0.8, 3, 0.8)(t);
    return t > 1.8 && t < 4.8 ? base + 0.04 * Math.sin(2 * Math.PI * hz * t) + 0.02 * (t - 1.8) : base;
  };
  test('speech on top of the open mouth (5 Hz at 15 fps) is rejected', () => {
    expect(yawns(yawnMar(0.4, 0.8, 3, 0.8))).toEqual(['yawn']);
    expect(yawns(talk(5))).toEqual([]);
  });
  test('4 Hz at 10 fps is rejected too (the band limited by fps/2)', () => {
    expect(yawns(yawnMar(0.4, 0.8, 3, 0.8), { fps: 10 })).toEqual(['yawn']);
    expect(yawns(talk(4), { fps: 10 })).toEqual([]);
  });
  test('the speech band: [3, min(8, fps/2)] Hz over [0.3, fps/2] Hz', () => {
    const tone = (hz: number, fps: number) => Array.from({ length: 2 * fps }, (_, i) => Math.sin((2 * Math.PI * hz * i) / fps));
    expect(speechRatio(tone(5, 15), 15)).toBeGreaterThan(0.9);
    expect(speechRatio(tone(1, 15), 15)).toBeLessThan(0.1);
    expect(speechRatio(tone(10, 30), 30)).toBeLessThan(0.1); // above 8 Hz at 30 fps: not speech
    expect(speechRatio(tone(6, 30), 30)).toBeGreaterThan(0.9);
  });
  test('a laugh (mouth width ≥ 1.15 × neutral during the rise) is rejected; 1.14 × is not', () => {
    const wide = (k: number) => (t: number) => (t >= 1 && t < 1.8 ? 0.9 * k : 0.9);
    expect(yawns(yawnMar(0.4, 0.8, 2.2, 0.8), { width: wide(1.16) })).toEqual([]);
    expect(yawns(yawnMar(0.4, 0.8, 2.2, 0.8), { width: wide(1.14) })).toEqual(['yawn']);
  });
  test('rev1 I4: a neutral of 0.01 (floored to 0.05) with talking at MAR 0.08 → no yawn; a 3 s yawn at MAR 0.6 → yawn; openness 2.6 at MAR 0.3 → no yawn', () => {
    expect(yawns((t) => 0.08 + 0.01 * Math.sin(2 * Math.PI * 4 * t), { neutralMar: 0.05 })).toEqual([]);
    expect(yawns(yawnMar(0.6, 0.8, 3, 0.8), { neutralMar: 0.05 })).toEqual(['yawn']);
    expect(yawns(yawnMar(0.3, 0.8, 2.5, 0.8), { neutralMar: 0.115 })).toEqual([]);
  });
  test('rev1 m7: no yawns below the 9 fps floor', () => {
    expect(yawns(yawnMar(0.4, 0.8, 2.2, 0.8), { fps: 8 })).toEqual([]);
    expect(yawns(yawnMar(0.4, 0.8, 2.2, 0.8), { fps: 10 })).toEqual(['yawn']);
  });
});
