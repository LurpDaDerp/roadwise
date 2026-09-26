// Task C7 (review-C2 §3; rev4 §2.3.6; rev5 §2; review-C6 deviation-2 ruling and Round 2): eye-movers reading a lap
// phone, through the engine façade. The synth lid follows the gaze with a lag of 150 ms or 50 ms; its floor is 0.20
// since C7 round 4 (the K12 release gate's margin; W4's 0.17 is recorded as the overlap case in S-READING-NOISE), and
// per-frame EAR noise (σ 0.03) lands on every frame. The head is 20 % of the gaze; in the "blink" variants a blink
// lands on the saccade down in 25 % of the bouts.
// Every variant runs under both iris models (0.2: C6 round 1's; 0.33: the C2 reviewer's), against the moving-derived
// EAR (a calibrated drive), and at a stop also with no reference at all (C6-2's prior mode).
// Every variant runs the review's 10 min.
// (Split into four files in T9 so Jest runs them in parallel: reading.test.ts, reading-levelhead.test.ts,
// reading-moving.test.ts and reading-noise.test.ts.)
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine, feedsDrowsinessScore, type DmsEvent } from '../../engine/engine';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverState } from '../synth';
import { boutsWithF1, f1s, playReading, type ReadingOpts } from '../__fixtures__/reading';

const SECS = 600;
const IRIS = [0.2, 0.33] as const;
const PITCH = [-40, -45] as const;

describe('S-READING-40/-45: the same at 60 km/h, 15 fps', () => {
  const base = (pitch: number, lag: number, iris: number, blinkShare: number): ReadingOpts => ({ pitch, fps: 15, lidLagS: lag, blinkShare, speedKmh: 60, calibrated: true, irisMinLid: iris, seconds: SECS });
  const cases: [number, number, number][] = [];
  for (const pitch of PITCH) for (const lag of [0.15, 0.05]) for (const iris of IRIS) cases.push([pitch, lag, iris]);
  test.each(cases)('%i°, lid lag %f s, iris model %f, no blink on the saccade: 0 F1 (≤ 3 %% of bouts at 50 ms; NC-T7e)', (pitch, lag, iris) => {
    const x = playReading(base(pitch, lag, iris, 0));
    expect(x.closures.filter((c) => c > 1200).length).toBeGreaterThanOrEqual(5);
    if (lag >= 0.15) expect(f1s(x)).toEqual([]);
    else expect(boutsWithF1(x)).toBeLessThanOrEqual(Math.floor(0.03 * x.bouts.length));
  });
  // The stated residual (review-C2 §3): at speed a blink ON the saccade with no iris after it (a lid at or below the
  // iris model's threshold) leaves no gaze to read, and R-b is stop-only; such a bout may alert. C7 round 1 (review-C7
  // C7-4, S-READING-BLINK): those F events are delivered but `shallow` (the episode was never deep), so they feed no
  // fatigue floor, gate or score: the fatigue level is the blink-free run's, and no episode feeds the score.
  test.each(cases)('S-READING-BLINK %i°, lid lag %f s, iris model %f, 25 %% blinks on the saccade: only in those bouts, all shallow, the level unchanged (NC-C7-4)', (pitch, lag, iris) => {
    const x = playReading(base(pitch, lag, iris, 0.25));
    const hit = x.bouts.filter((b) => f1s(x).some((e) => e.tMs >= b.start * 1000 && e.tMs < (b.end + 1) * 1000));
    expect(hit.filter((b) => !b.blink).length).toBeLessThanOrEqual(Math.floor(0.03 * x.bouts.length));
    const sleepEvents = x.events.filter((e) => (e.kind === 'microsleep' || e.kind === 'sleep' || e.kind === 'unresponsive') && e.tMs >= x.t0 * 1000);
    expect(sleepEvents.filter((e) => (e as { shallow?: boolean }).shallow !== true)).toEqual([]);
    const ends = x.events.filter((e): e is Extract<DmsEvent, { kind: 'episode_end' }> => e.kind === 'episode_end' && e.tMs >= x.t0 * 1000);
    expect(ends.filter((e) => feedsDrowsinessScore(e, DEFAULT_DMS_CONFIG.fatigue.stopEventsFeed))).toEqual([]);
    const clean = playReading(base(pitch, lag, iris, 0));
    expect(x.maxFatigueLevel).toBe(clean.maxFatigueLevel);
  });
});

// C7 round 2 (review-C7 R1-F): a lap reader is not graded drowsy. PERCLOS takes its looking-down threshold (0.15)
// inside a latched episode too, and a closure of ≥ 500 ms that was never deep for 300 ms is no blink.
describe('S-READING-FATIGUE: reading at 60 km/h raises no fatigue level (NC-C7-5, NC-C7-6, NC-C7-13)', () => {
  const cases: [number, number, number][] = [];
  for (const pitch of PITCH) for (const lag of [0.15, 0.05]) for (const iris of IRIS) cases.push([pitch, lag, iris]);
  // C7 round 5 (review-C7 Round 4, should-fix; NC-C7-13): the level none, and every scored minute back at ≤ 20: in an
  // episode latched at any point the blink is its longest deep run, so a reading closure that holds a natural blink is
  // that blink (round 4 counted the whole 3–8 s closure as one long blink: 21.1–21.4 at −45°).
  test.each(cases)('%i°, lid lag %f s, iris model %f, 15 fps, no blink on the saccade: the level none, every scored minute ≤ 20', (pitch, lag, iris) => {
    const x = playReading({ pitch, fps: 15, lidLagS: lag, blinkShare: 0, speedKmh: 60, calibrated: true, irisMinLid: iris, seconds: SECS });
    expect(x.maxFatigueLevel).toBe('none');
    const scores = x.events.filter((e): e is Extract<DmsEvent, { kind: 'fatigue_minute' }> => e.kind === 'fatigue_minute').map((e) => e.score).filter((s): s is number => s !== null);
    expect(scores.length).toBeGreaterThan(0);
    expect(Math.max(...scores)).toBeLessThanOrEqual(20);
  });
});

// C7 round 2 (R1-F): the rules do not blind a drowsy driver who looks down: deep long blinks at the cluster (latched)
// are counted, and the level reaches that of the same drive looking at the road, within one level.
describe('S-DROWSY-DOWN: a drowsy driver at the cluster is still graded', () => {
  const LEVELS = ['none', 'early', 'drowsy', 'severe'];
  const drowsy = (atCluster: boolean) => {
    const items = synthDrive({
      fps: 15,
      seconds: 1300,
      seed: 3,
      source: 'geometric',
      motion: true,
      driver: (t, r) => {
        const base: DriverState = { gaze: onRoad(r), openness: blinkOpenness(t), speedKmh: 90 };
        if (t < 660) return base;
        // long, deep blinks: 0.6–1.2 s at openness 0.1 every 3 s
        const k = (t - 660) % 3;
        const len = 0.6 + 0.6 * ((Math.floor((t - 660) / 3) * 0.618) % 1);
        const o: DriverState = { ...base, openness: k < len ? 0.1 : 1 };
        return atCluster ? { ...o, gaze: rel(0, -20), head: { yaw: 0.8, pitch: -7 } } : o;
      },
    });
    const e = createDmsEngine(DEFAULT_DMS_CONFIG as DmsConfig, { ...DEFAULT_INIT, profile: null });
    let max = 0;
    let longBlinks = 0;
    for (const it of items) {
      if (it.row !== undefined) e.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      e.pushFrame(it.frame);
      for (const ev of e.drain().events) {
        if (ev.kind === 'fatigue_minute') max = Math.max(max, LEVELS.indexOf(ev.level));
        if (ev.kind === 'blink' && ev.long === true && ev.tMs > 660_000) longBlinks++;
      }
    }
    return { max, longBlinks };
  };
  test('long blinks counted, and the level within one of the road-looking drive', () => {
    const road = drowsy(false);
    const down = drowsy(true);
    expect(road.max).toBeGreaterThanOrEqual(LEVELS.indexOf('drowsy'));
    expect(down.longBlinks).toBeGreaterThan(100);
    expect(down.max).toBeGreaterThanOrEqual(road.max - 1);
  });
});
