// The fatigue score (plan §M7, Task 10): baselines, sub-score ramps, frame-rate-aware weights, the
// amplifiers, levels, the fast rules' floor, action timers, `insufficient`, and C-26 (bridged time).
import { DEFAULT_DMS_CONFIG, resolveDmsConfig, type DmsConfig } from '../config';
import { createFatigue, createFatigueActions, levelOf, subScore, type FatigueFrame, type FatigueMinute } from '../fatigue';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const S = C.fatigue.signals;

type Fz = ReturnType<typeof createFatigue>;

/**
 * Frames at `fps` over [fromS, toS). The default frame: TRACKING, eyes open, 60 km/h, midday, a gaze
 * that scans with periods (5 s, 4 s) dividing every window, so the dispersion of any window equals the
 * baseline's.
 */
function feed(fz: Fz, fromS: number, toS: number, fps: number, spec: (t: number) => Partial<FatigueFrame> = () => ({}), onT?: (t: number) => void): FatigueMinute[] {
  const out: FatigueMinute[] = [];
  const n0 = Math.round(fromS * fps);
  const n1 = Math.round(toS * fps);
  for (let i = n0; i < n1; i++) {
    const t = i / fps;
    const x: FatigueFrame = {
      tMs: t * 1000,
      dtS: 1 / fps,
      quality: 'tracking',
      closureBridged: false,
      hasHead: true,
      openness: 1,
      lookingDown: false,
      gazeRel: { yaw: 3 * Math.sin((2 * Math.PI * t) / 5), pitch: 2 * Math.cos((2 * Math.PI * t) / 4) },
      speedKmh: 60,
      fps,
      hot: false,
      tripElapsedS: t,
      localMinutes: 720,
      floor: 'none',
      ...spec(t),
    };
    onT?.(t);
    const m = fz.onFrame(x);
    if (m !== null) out.push(m);
  }
  return out;
}
/** Every `every` s, a counted blink of `durMs` (the i-th frame of each period). */
const blinker = (fz: Fz, fps: number, every: number, durMs: number) => (t: number) => {
  const i = Math.round(t * fps);
  if (i % Math.round(every * fps) === 0 && t > 0) fz.onBlink({ tMs: t * 1000, durMs, long: durMs >= 500, counted: fps >= 12.5 });
};
/** 10 min of plain driving: the baselines (PERCLOS 0, one 200 ms blink every 4 s, no nods or yawns). */
function learned(fps = 15): { fz: Fz; minutes: FatigueMinute[] } {
  const fz = createFatigue(C);
  const minutes = feed(fz, 0, 610, fps, undefined, blinker(fz, fps, 4, 200));
  return { fz, minutes };
}
/** 20 % closed per 10 s: PERCLOS 0.2, past the 0.15 target (sub-score 1 on a baseline of 0). */
const perclos20 = (t: number): Partial<FatigueFrame> => ((t % 10) < 2 ? { openness: 0.1 } : {});

describe('learning and the baselines', () => {
  test('no score before 10 min at ≥ 20 km/h, and only frames at a known speed count (5 min at 5 km/h and 11 min unknown first → scored only after 26 min)', () => {
    const { minutes } = learned();
    // Nine learning minutes; the tenth closes on the frame that completes 10 min at speed.
    expect(minutes.slice(0, 9).every((m) => m.status === 'learning')).toBe(true);
    expect(minutes[9]!.status).toBe('scored');
    const fz = createFatigue(C);
    const ms = [...feed(fz, 0, 300, 15, () => ({ speedKmh: 5 })), ...feed(fz, 300, 960, 15, () => ({ speedKmh: null })), ...feed(fz, 960, 1560, 15)];
    // 5 min slow, 11 min unknown speed, then 10 min at speed: learning until the 26th minute.
    expect(ms.filter((m) => m.tMs <= 1500_000).every((m) => m.status === 'learning')).toBe(true);
    expect(feed(fz, 1560, 1630, 15).at(-1)!.status).toBe('scored');
  });
  test('driving like the baseline scores 0; PERCLOS 0.2 on a baseline of 0 is sub-score 1', () => {
    const { fz } = learned();
    const same = feed(fz, 610, 1300, 15, undefined, blinker(fz, 15, 4, 200));
    expect(same.every((m) => m.status === 'scored')).toBe(true);
    for (const m of same) expect(m.score).toBeCloseTo(0, 6);
    const drowsy = feed(fz, 1300, 1400, 15, perclos20, blinker(fz, 15, 4, 200));
    expect(drowsy.at(-1)!.sub.perclos).toBe(1);
    expect(drowsy.at(-1)!.score).toBeCloseTo(30, 6); // weight 0.30
  });
  test('a baseline PERCLOS of 0.05: 0.05 scores 0 and 0.15 scores 1 (e = max(0.15, 0.05 + 0.07))', () => {
    const fz = createFatigue(C);
    const p5 = (t: number): Partial<FatigueFrame> => ((t % 20) < 1 ? { openness: 0.1 } : {});
    feed(fz, 0, 610, 15, p5);
    expect(feed(fz, 610, 700, 15, p5).at(-1)!.sub.perclos).toBeCloseTo(0, 6);
    const p15 = (t: number): Partial<FatigueFrame> => ((t % 20) < 3 ? { openness: 0.1 } : {});
    expect(feed(fz, 700, 800, 15, p15).at(-1)!.sub.perclos).toBeCloseTo(1, 6);
  });
});

describe('sub-score ramps (§M7)', () => {
  test('0 at b, 0.5 at the midpoint, 1 at e; clamped', () => {
    expect(subScore(0.02, 0.02, S.perclos)).toBe(0);
    expect(subScore(0.085, 0.02, S.perclos)).toBeCloseTo(0.5, 9);
    expect(subScore(0.15, 0.02, S.perclos)).toBe(1);
    expect(subScore(0.5, 0.02, S.perclos)).toBe(1);
    expect(subScore(0, 0.02, S.perclos)).toBe(0);
  });
  test('b ≥ target: the margin path (e = b + margin)', () => {
    expect(subScore(0.2, 0.2, S.perclos)).toBe(0);
    expect(subScore(0.235, 0.2, S.perclos)).toBeCloseTo(0.5, 9);
    expect(subScore(0.27, 0.2, S.perclos)).toBeCloseTo(1, 9);
    expect(subScore(4.5, 3.5, S.longBlinks)).toBeCloseTo(0.5 / 1.5 * 2, 9); // e = 5: (4.5 − 3.5) / 1.5
  });
  test('no margin (dispersion): e = target', () => {
    expect(subScore(0.25, 0, S.dispersion)).toBeCloseTo(0.5, 9);
    expect(subScore(0.5, 0, S.dispersion)).toBe(1);
  });
});

describe('frame-rate-aware weights (§M7, T6 review I2 floors, rev1 R-U4)', () => {
  test('at 10 fps the two blink rows drop and the rest renormalise; the minute is degraded (low_fps)', () => {
    const { fz } = learned(10);
    const m = feed(fz, 610, 700, 10, perclos20).at(-1)!;
    expect(m.sub.longBlinks).toBeNull();
    expect(m.sub.blinkDuration).toBeNull();
    expect(m.sub.perclos).toBe(1);
    expect(m.score).toBeCloseTo((100 * 0.3) / 0.65, 6);
    expect(m.degraded).toBe(true);
    expect(m.reason).toBe('low_fps');
    expect(m.perclosDropped).toBe(false);
  });
  test('at 8 fps PERCLOS and yawns drop too; PERCLOS-dropped minutes are counted; a hot minute says hot', () => {
    const { fz } = learned(8);
    const m = feed(fz, 610, 700, 8, perclos20).at(-1)!;
    expect(m.sub.perclos).toBeNull();
    expect(m.sub.yawns).toBeNull();
    expect(m.sub.nods).not.toBeNull();
    expect(m.score).toBeCloseTo(0, 6);
    expect(m.perclosDropped).toBe(true);
    expect(fz.stats().perclosDroppedMinutes).toBeGreaterThanOrEqual(1);
    const hot = feed(fz, 700, 770, 8, () => ({ hot: true })).at(-1)!;
    expect(hot.reason).toBe('hot');
    expect(fz.stats().degradedMinutes.hot).toBe(1);
    expect(fz.stats().degradedMinutes.low_fps).toBeGreaterThanOrEqual(1);
  });
  test('at 15 fps nothing drops', () => {
    const { fz } = learned(15);
    const m = feed(fz, 610, 700, 15).at(-1)!;
    expect(Object.values(m.sub).every((v) => v !== null)).toBe(true);
    expect(m.degraded).toBe(false);
    expect(m.reason).toBeNull();
  });
});

describe('the amplifiers and the cap', () => {
  test('they never raise a zero: a 3 h trip at 02:00 with baseline driving scores 0', () => {
    const { fz } = learned();
    const ms = feed(fz, 610, 800, 15, (t) => ({ tripElapsedS: 3 * 3600 + t, localMinutes: 120 }), blinker(fz, 15, 4, 200));
    for (const m of ms) expect(m.score).toBeCloseTo(0, 6);
  });
  test('they multiply real evidence: PERCLOS alone (30) → × 1.15 × 1.15', () => {
    const { fz } = learned();
    const m = feed(fz, 610, 700, 15, (t) => ({ ...perclos20(t), tripElapsedS: 3 * 3600, localMinutes: 120 }), blinker(fz, 15, 4, 200)).at(-1)!;
    expect(m.score).toBeCloseTo(30 * 1.15 * 1.15, 6);
  });
  test('every row at 1 with both amplifiers is capped at 100', () => {
    const { fz } = learned();
    for (let i = 0; i < 3; i++) fz.onNod(620_000 + i * 1000);
    for (let i = 0; i < 4; i++) fz.onYawn(630_000 + i * 1000);
    const m = feed(
      fz,
      610,
      1000, // past a full 5 min of a still gaze: dispersion reduced to 0 → x = 1
      15,
      (t) => ({ ...perclos20(t), gazeRel: { yaw: 0, pitch: 0 }, tripElapsedS: 3 * 3600, localMinutes: 120 }),
      blinker(fz, 15, 2, 600) // 30 long blinks per minute, 3 × the baseline duration
    ).at(-1)!;
    expect(m.sub).toEqual({ perclos: 1, longBlinks: 1, blinkDuration: 1, nods: 1, yawns: 1, dispersion: 1 });
    expect(m.score).toBe(100);
  });
});

describe('levels, the floor and the actions', () => {
  test('levels at 39/40/59/60/79/80', () => {
    const L = C.fatigue.levels;
    expect([39, 40, 59, 60, 79, 80].map((s) => levelOf(s, L))).toEqual(['none', 'early', 'early', 'drowsy', 'drowsy', 'severe']);
  });
  test('the F1 hold (at least Drowsy) and F4 (Severe) from the fast rules, even while learning', () => {
    const fz = createFatigue(C);
    const ms = feed(fz, 0, 130, 15, (t) => ({ floor: t < 65 ? 'drowsy' : 'severe' }));
    expect(ms[0]!.status).toBe('learning');
    expect(ms[0]!.level).toBe('drowsy');
    expect(ms[0]!.actions).toEqual([{ kind: 'fatigue', tier: 2, level: 'drowsy', event: false, tMs: 60_000 }]);
    expect(ms[1]!.level).toBe('severe');
    expect(ms[1]!.actions[0]).toMatchObject({ kind: 'fatigue', tier: 2, level: 'severe', event: true });
  });
  test('action timers: early once per 20 min, drowsy every 5 min, severe every 2 min', () => {
    const at = (level: 'early' | 'drowsy' | 'severe') => {
      const a = createFatigueActions(C);
      const fired: number[] = [];
      for (let m = 0; m <= 40; m++) if (a.onMinute(m * 60_000, level).length > 0) fired.push(m);
      return fired;
    };
    expect(at('early')).toEqual([0, 20, 40]);
    expect(at('drowsy')).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40]);
    expect(at('severe')).toEqual(Array.from({ length: 21 }, (_, i) => 2 * i));
    const a = createFatigueActions(C);
    expect(a.onMinute(0, 'early')[0]).toMatchObject({ kind: 'fatigue_early', tier: 1, event: false });
    expect(a.onMinute(60_000, 'none')).toEqual([]);
  });
});

describe('insufficient and C-26', () => {
  test('TRACKING < 50 % of the last 60 s → insufficient, with no score; 60 % → scored', () => {
    const { fz } = learned();
    const m40 = feed(fz, 610, 730, 15, (t) => ((t % 10) < 6 ? { quality: 'head_only', openness: null } : {})).at(-1)!;
    expect(m40.status).toBe('insufficient');
    expect(m40.score).toBeNull();
    const m60 = feed(fz, 730, 790, 15, (t) => ((t % 10) < 4 ? { quality: 'head_only', openness: null } : {})).at(-1)!;
    expect(m60.status).toBe('scored');
  });
  test('bridged time is not TRACKING time (C-26): 40 % TRACKING + 60 % bridged is insufficient', () => {
    const { fz } = learned();
    const m = feed(fz, 610, 730, 15, (t) => ((t % 10) < 6 ? { quality: 'lost', closureBridged: true, openness: null, gazeRel: null } : {})).at(-1)!;
    expect(m.status).toBe('insufficient');
  });
  test('bridged time never enters PERCLOS (C-26), even on a frame that still reports TRACKING and a low openness', () => {
    const { fz } = learned();
    const m = feed(fz, 610, 700, 15, (t) => ((t % 10) < 2 ? { closureBridged: true, openness: 0.1 } : {})).at(-1)!;
    expect(m.sub.perclos).toBe(0);
  });
});

describe('rates by observed time (T10 review I1)', () => {
  /** 40 % of every 10 s LOST (no head, no eyes). */
  const lost40 = (t: number): Partial<FatigueFrame> => ((t % 10) < 4 ? { quality: 'lost', hasHead: false, openness: null, gazeRel: null } : {});
  /**
   * Events by OBSERVED time: a long blink every 10 s, a nod every 20 s and a yawn every 30 s of observed
   * time (TRACKING for blinks and yawns, a head for nods), whatever the share observed.
   */
  function driver(fz: Fz, fps: number, spec: (t: number) => Partial<FatigueFrame>) {
    let obs = 0;
    return (t: number) => {
      const f = spec(t);
      if ((f.quality ?? 'tracking') !== 'tracking') return;
      const before = obs;
      obs += 1 / fps;
      const crossed = (every: number) => Math.floor(obs / every + 1e-9) > Math.floor(before / every + 1e-9);
      if (crossed(10)) fz.onBlink({ tMs: t * 1000, durMs: 600, long: true, counted: true });
      if (crossed(20)) fz.onNod(t * 1000);
      if (crossed(30)) fz.onYawn(t * 1000);
    };
  }
  const ratio = (m: FatigueMinute, k: 'longBlinks' | 'nods' | 'yawns') => m.raw[k]!.x / m.raw[k]!.b;

  test('a driver identical to the baseline with 40 % of the current window LOST reads as the baseline (not low)', () => {
    const fz = createFatigue(C);
    feed(fz, 0, 610, 15, undefined, driver(fz, 15, () => ({})));
    const m = feed(fz, 610, 1600, 15, lost40, driver(fz, 15, lost40)).at(-1)!;
    expect(m.status).toBe('scored');
    for (const k of ['longBlinks', 'nods', 'yawns'] as const) {
      expect(ratio(m, k)).toBeGreaterThan(0.85);
      expect(ratio(m, k)).toBeLessThan(1.15);
    }
  });
  test('a baseline learned with 40 % LOST, then a fully observed identical driver, reads as the baseline (not high)', () => {
    const fz = createFatigue(C);
    feed(fz, 0, 1100, 15, lost40, driver(fz, 15, lost40)); // learning ends at 600 s (speed, not observation, sets it); scoring continues in the same mode
    const m = feed(fz, 1100, 2100, 15, undefined, driver(fz, 15, () => ({}))).at(-1)!;
    expect(m.status).toBe('scored');
    for (const k of ['longBlinks', 'nods', 'yawns'] as const) {
      expect(ratio(m, k)).toBeGreaterThan(0.85);
      expect(ratio(m, k)).toBeLessThan(1.15);
    }
    for (const k of ['longBlinks', 'nods', 'yawns'] as const) expect(m.sub[k]).toBeLessThan(0.2);
  });
  test('a row observed for under 50 % of its window is dropped as sparse, not degraded', () => {
    const { fz } = learned();
    const lost70 = (t: number): Partial<FatigueFrame> => ((t % 10) < 7 ? { quality: 'lost', hasHead: false, openness: null, gazeRel: null } : {});
    feed(fz, 610, 1510, 15, lost70);
    const m = feed(fz, 1510, 1575, 15).at(-1)!;
    expect(m.status).toBe('scored');
    for (const k of ['longBlinks', 'blinkDuration', 'nods', 'yawns', 'dispersion'] as const) expect(m.sub[k]).toBeNull();
    expect(m.sparse).toEqual(expect.arrayContaining(['longBlinks', 'blinkDuration', 'nods', 'yawns', 'dispersion']));
    expect(m.sub.perclos).not.toBeNull();
    expect(m.degraded).toBe(false);
    expect(m.reason).toBeNull();
    expect(fz.stats().sparseRowMinutes.nods).toBeGreaterThanOrEqual(1);
  });
  test('HEAD_ONLY keeps nods observed (a head pose), not blinks', () => {
    const { fz } = learned();
    const head70 = (t: number): Partial<FatigueFrame> => ((t % 10) < 7 ? { quality: 'head_only', openness: null } : {});
    feed(fz, 610, 1510, 15, head70);
    const m = feed(fz, 1510, 1575, 15).at(-1)!;
    expect(m.sub.nods).not.toBeNull();
    expect(m.sub.longBlinks).toBeNull();
  });
});

describe('T10 review m1 and nit', () => {
  test('PERCLOS needs perclosMinTrackingS of TRACKING in its window, apart from the 50 % minute rule', () => {
    const cfg = resolveDmsConfig({ fatigue: { perclosMinTrackingS: 45 } });
    const run = (c: DmsConfig) => {
      const fz = createFatigue(c);
      feed(fz, 0, 610, 15);
      return feed(fz, 610, 730, 15, (t) => ((t % 10) < 3 ? { quality: 'head_only', openness: null } : {})).at(-1)!; // the minute to 720 s: 70 % TRACKING, 42 s
    };
    const strict = run(cfg);
    expect(strict.status).toBe('scored');
    expect(strict.sub.perclos).toBeNull();
    expect(strict.perclosDropped).toBe(true);
    expect(strict.sub.nods).not.toBeNull();
    expect(run(C).sub.perclos).not.toBeNull();
  });
  test('an unknown local time is not night (never 00:00)', () => {
    const { fz } = learned();
    const m = feed(fz, 610, 700, 15, (t) => ({ ...perclos20(t), tripElapsedS: 3 * 3600, localMinutes: null }), blinker(fz, 15, 4, 200)).at(-1)!;
    expect(m.score).toBeCloseTo(30 * 1.15, 6);
  });
});
