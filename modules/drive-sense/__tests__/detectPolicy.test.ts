/** @jest-environment node */
// The drive detector's rules (plan §3.3, §3.4, §3.6): every row of the shared decision table holds
// for the TypeScript reference, the numbers agree with the scoring package and the triggers the UI
// quotes, and a few properties hold over generated rows as well as the table's.
import { END_CRAWL_MPH, END_NATIVE_SLACK_S, IDLE_END_S, MERGE_GAP_S, MERGE_RADIUS_M, WALK_END_S } from '@scoring';

import {
  AUTO_TRIGGER,
  autoHoldMs,
  candidateDue,
  CONFIRM_START,
  confirmStep,
  DETECT,
  distanceM,
  endClockAt,
  endDue,
  endOnRow,
  MANUAL_TRIGGER,
  MPS_PER_MPH,
  rolling,
  slow,
  startOf,
  startsAfter,
  suppressionDue,
  suppressionResume,
  traceStart,
  trusted,
  type ConfirmState,
  type DetectRow,
} from '../src/detect/policy';
import { matchDetectRow, runDetectRow } from '../src/detect/selfTest';
import { DETECT_VECTORS, T0, vrow, vrows } from '../src/detect/vectors';

describe('the decision table', () => {
  test('names are unique', () => {
    const names = DETECT_VECTORS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(DETECT_VECTORS.map((v) => [v.name, v] as const))('%s', (_n, v) => {
    // through JSON both ways, as the row and the answer travel to and from native
    const { expected: _e, name: _name, ...inputs } = JSON.parse(JSON.stringify(v)) as typeof v;
    const actual = JSON.parse(JSON.stringify(runDetectRow(inputs as Parameters<typeof runDetectRow>[0])));
    expect(matchDetectRow(v, actual)).toEqual([]);
  });

  test('every rule has rows', () => {
    const kinds = new Set(DETECT_VECTORS.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(['candidate', 'confirm', 'end', 'motionGate', 'resume', 'resumeSeq', 'start', 'startsAfter', 'status', 'summary', 'suppress', 'suppressResume', 'trace', 'wake'].sort());
  });
});

describe('the numbers', () => {
  test('the triggers the UI quotes are the ones confirmed', () => {
    expect(AUTO_TRIGGER).toEqual({ minMph: 15, maxHoldS: 25, stepS: 5, stepMph: 3, instantMph: 30, maxHAccM: 30 });
    // the quoted rule is the line the constants draw: 25 s at 15 mph, 5 s less every 3 mph, 0 at 30
    expect(DETECT.AUTO_MIN_MPS).toBeCloseTo(AUTO_TRIGGER.minMph * MPS_PER_MPH, 9);
    expect(DETECT.AUTO_INSTANT_MPS).toBeCloseTo(AUTO_TRIGGER.instantMph * MPS_PER_MPH, 9);
    expect(DETECT.AUTO_HOLD_MS_15).toBe(AUTO_TRIGGER.maxHoldS * 1000);
    expect((AUTO_TRIGGER.stepS / AUTO_TRIGGER.stepMph) * (AUTO_TRIGGER.instantMph - AUTO_TRIGGER.minMph)).toBe(AUTO_TRIGGER.maxHoldS);
    expect(DETECT.AUTO_MPS_20).toBeCloseTo(20 * MPS_PER_MPH, 9);
    // y = (-5/3)·(x - 30) s over 15 mph
    for (const mph of [15.01, 16, 17.5, 18, 20, 21, 22, 24, 25, 27, 29]) {
      expect({ mph, ms: autoHoldMs(mph * MPS_PER_MPH) }).toEqual({ mph, ms: expect.closeTo((-5 / 3) * (mph - 30) * 1000, 6) });
    }
    for (const [mph, s] of [[18, 20], [21, 15], [24, 10], [27, 5]] as const) expect(autoHoldMs(mph * MPS_PER_MPH)).toBeCloseTo(s * 1000, 6);
    // 15 mph and under: never
    for (const mph of [15, 14.99, 10, 0]) expect(autoHoldMs(mph * MPS_PER_MPH)).toBe(Infinity);
    expect(autoHoldMs(DETECT.AUTO_MIN_MPS)).toBe(Infinity);
    expect(autoHoldMs(Number.NaN)).toBe(Infinity);
    // from 29.4 mph (30 mph and over included): the 1 s floor, the second reading in a row
    for (const mph of [29.5, 30, 31, 35, 40, 90]) expect(autoHoldMs(mph * MPS_PER_MPH)).toBe(DETECT.AUTO_HOLD_MIN_MS);
    expect(DETECT.AUTO_HOLD_MIN_MS).toBe(DETECT.ROW_MS);
    // the Start card's
    expect(DETECT.CONFIRM_MPS_MANUAL).toBeCloseTo(MANUAL_TRIGGER.mph * MPS_PER_MPH, 9);
    expect(DETECT.CONFIRM_HOLD_MS_MANUAL).toBe(MANUAL_TRIGGER.holdMs);
    expect(MANUAL_TRIGGER.dipMaxMs).toBe(DETECT.CONFIRM_DIP_MAX_MS);
    for (const t of [AUTO_TRIGGER, MANUAL_TRIGGER]) expect(t.maxHAccM).toBe(DETECT.TRUSTED_HACC_M);
    expect(MANUAL_TRIGGER).toEqual({ mph: 10, holdMs: 15_000, dipMaxMs: 5_000, maxHAccM: 30 });
  });

  test('a hold never gets longer as the speed rises, and stays between the floor and 25 s', () => {
    let last = Infinity;
    for (let mph = 15.25; mph <= 60; mph += 0.25) {
      const h = autoHoldMs(mph * MPS_PER_MPH);
      expect({ mph, ok: h <= last && h >= DETECT.AUTO_HOLD_MIN_MS && h <= DETECT.AUTO_HOLD_MS_15 }).toEqual({ mph, ok: true });
      last = h;
    }
  });

  test('the watch: the buffer holds the whole of the longest candidate; evidence lives as long as a stop inside a drive', () => {
    expect(DETECT.CANDIDATE_BUFFER_MAX_ROWS * DETECT.ROW_MS).toBe(DETECT.CANDIDATE_CAP_MS);
    expect(DETECT.CANDIDATE_CAP_MS).toBe(30 * 60_000);
    expect(DETECT.AUTO_FORGET_MS).toBe(DETECT.STILL_END_MS);
    expect(DETECT.AUTO_FORGET_MS).toBe(DETECT.TRACE_STOP_SPLIT_MS);
    expect(DETECT.CANDIDATE_MAX_MS).toBe(3 * 60_000);
    expect(DETECT.AUTO_ROW_GAP_MAX_MS).toBe(2 * DETECT.ROW_MS);
  });

  test('the end and merge numbers are the scoring package’s (plan §3.4, §3.5)', () => {
    expect(DETECT.STILL_END_MS).toBe(IDLE_END_S * 1000);
    expect(DETECT.SAFETY_SLACK_MS).toBe(END_NATIVE_SLACK_S * 1000);
    expect(DETECT.END_CRAWL_MPS).toBeCloseTo(END_CRAWL_MPH * MPS_PER_MPH, 9);
    expect(DETECT.STOP_MPS).toBeCloseTo(3 * MPS_PER_MPH, 9);
    expect(DETECT.MOVING_MPS).toBeCloseTo(10 * MPS_PER_MPH, 9);
    expect(DETECT.MOVE_MPS).toBeCloseTo(5 * MPS_PER_MPH, 9);
    expect(DETECT.CONTINUE_GAP_MS).toBe(MERGE_GAP_S * 1000);
    expect(DETECT.CONTINUE_DIST_M).toBe(MERGE_RADIUS_M);
    expect(DETECT.TRACE_STOP_SPLIT_MS).toBe(MERGE_GAP_S * 1000);
    expect(DETECT.MAX_DRIVE_MS).toBe(12 * 3_600_000);
    expect(DETECT.SUPPRESS_MAX_MS).toBe(3 * 3_600_000);
    expect(DETECT.WAIT_MAX_MS).toBe(5 * 60_000);
    // the walking end: 5 s for a drive (native stops 60 s after that), 20 s for a candidate and the rest
    expect(DETECT.WALK_END_MS).toBe(WALK_END_S * 1000);
    expect(DETECT.WALK_END_MS).toBe(5_000);
    expect(DETECT.WALK_CONFIRM_MS).toBe(20_000);
  });

  test('every value is a plain decimal number Swift reads as written', () => {
    for (const [name, value] of Object.entries(DETECT)) {
      expect({ name, ok: Number.isFinite(value) && value > 0 && /^[\d.]+$/.test(String(value)) }).toEqual({ name, ok: true });
    }
  });
});

/** A small seeded generator, so a failure repeats. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** A minute or two of rows with random speeds, dips, gaps and poor fixes. */
function randomRows(seed: number, n = 240): DetectRow[] {
  const r = rng(seed);
  const out: DetectRow[] = [];
  let mph = r() * 25;
  for (let s = 0; s < n; s++) {
    mph = Math.max(0, Math.min(45, mph + (r() - 0.5) * 8));
    const kind = r();
    if (kind < 0.05) out.push(vrow(s, null));
    else if (kind < 0.1) out.push(vrow(s, mph, { hAcc: 40 + r() * 60 }));
    else out.push(vrow(s, r() < 0.15 ? 0 : mph, { northM: s * 5 }));
  }
  return out;
}

describe('properties', () => {
  test('the Start card: a hold never confirms across a dip spanning more than 5 s, and always spans the hold', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rows = randomRows(seed);
      let s = CONFIRM_START;
      for (const row of rows) {
        const step = confirmStep(s, row, 'manual');
        s = step.state;
        if (!step.confirmed) continue;
        const run = rows.filter((x) => x.ts >= s.runStartTs! && x.ts <= row.ts);
        const fast = (x: DetectRow) => trusted(x) && x.speed >= DETECT.CONFIRM_MPS_MANUAL;
        expect(fast(run[0]!) && fast(row)).toBe(true);
        expect(row.ts - run[0]!.ts).toBeGreaterThanOrEqual(DETECT.CONFIRM_HOLD_MS_MANUAL);
        let dipStart: number | null = null;
        for (const x of run) {
          if (fast(x)) dipStart = null;
          else {
            dipStart = dipStart ?? x.ts;
            expect(x.ts - dipStart).toBeLessThanOrEqual(DETECT.CONFIRM_DIP_MAX_MS);
          }
        }
        break;
      }
    }
  });

  /** The auto evidence over `rows`: each row's state and whether it confirmed. */
  function autoRun(rows: readonly DetectRow[], veto: (i: number) => boolean = () => false, car: (i: number) => boolean = () => false) {
    let s: ConfirmState = CONFIRM_START;
    const out: { s: ConfirmState; confirmed: boolean }[] = [];
    rows.forEach((row, i) => {
      const step = confirmStep(s, row, 'auto', veto(i), car(i));
      s = step.state;
      out.push({ s, confirmed: step.confirmed });
    });
    return out;
  }
  const firstConfirm = (rows: readonly DetectRow[], veto?: (i: number) => boolean, car?: (i: number) => boolean) => autoRun(rows, veto, car).findIndex((x) => x.confirmed);
  const fast = (x: DetectRow) => trusted(x) && x.speed > DETECT.AUTO_MIN_MPS;

  test('auto: a confirmation always has its run start and the confirming row and the row before it trusted over 15 mph', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rows = randomRows(seed, 600);
      const r = rng(seed * 7);
      const car = rows.map(() => r() < 0.6);
      const steps = autoRun(rows, () => false, (i) => car[i]!);
      const c = steps.findIndex((x) => x.confirmed);
      if (c < 0) continue;
      const run = steps[c]!.s.runStartTs!;
      const h = rows.findIndex((x) => x.ts === run);
      expect({ seed, ok: h >= 0 && h < c && fast(rows[h]!) && fast(rows[c]!) && fast(rows[c - 1]!) }).toEqual({ seed, ok: true });
      // under 20 mph a row earned only with car motion
      if (rows[c]!.speed < DETECT.AUTO_MPS_20) expect(car[c]).toBe(true);
    }
  });

  test('auto: rows never over 15 mph never confirm (15.0 mph included), nor rows a fresh walk, run or ride report covers', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const slowRows = randomRows(seed, 400).map((x) => (x.speed >= DETECT.AUTO_MIN_MPS ? { ...x, speed: DETECT.AUTO_MIN_MPS } : x));
      expect({ seed, c: firstConfirm(slowRows, undefined, () => true) }).toEqual({ seed, c: -1 });
      expect({ seed, c: firstConfirm(randomRows(seed, 400), () => true, () => true) }).toEqual({ seed, c: -1 });
    }
  });

  test('auto: one GPS spike among rows that never reach 15 mph never confirms, wherever it lands', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const base = randomRows(seed, 200).map((x) => (x.speed >= DETECT.AUTO_MIN_MPS ? { ...x, speed: 10 * MPS_PER_MPH } : x));
      for (let i = 0; i < base.length; i += 7) {
        const rows = base.map((x, j) => (j === i ? vrow((x.ts - T0) / 1000, 60) : x));
        expect({ seed, i, c: firstConfirm(rows, undefined, () => true) }).toEqual({ seed, i, c: -1 });
      }
    }
  });

  test('auto: a higher steady speed never confirms later', () => {
    let last = Infinity;
    for (let mph = 15.5; mph <= 60; mph += 0.5) {
      const c = firstConfirm(vrows(0, 60, mph), undefined, () => true);
      expect({ mph, ok: c >= 1 && c <= last }).toEqual({ mph, ok: true });
      last = c;
    }
  });

  test('auto: the evidence only grows, except that 5 min with no trusted row over 3 mph forgets it', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      // driving, a long stop now and then, and poor fixes
      const rows: DetectRow[] = [];
      let t = 0;
      while (rows.length < 1200) {
        const stop = r() < 0.2 ? 250 + Math.floor(r() * 120) : Math.floor(r() * 60);
        rows.push(...vrows(t, t + stop - 1, 0));
        t += stop;
        const go = 3 + Math.floor(r() * 6);
        rows.push(...vrows(t, t + go - 1, 15 + r() * 6, () => ({ hAcc: r() < 0.1 ? 60 : 5 })));
        t += go;
      }
      const steps = autoRun(rows, () => false, () => r() < 0.5);
      let prev = CONFIRM_START;
      steps.forEach(({ s }, i) => {
        if (s.evidence < prev.evidence) {
          expect({ seed, i, e: s.evidence, first: s.runStartTs }).toEqual({ seed, i, e: 0, first: null });
          expect(rows[i]!.ts - prev.lastMoveTs!).toBeGreaterThanOrEqual(DETECT.AUTO_FORGET_MS);
        }
        expect(s.evidence > 0).toBe(s.runStartTs !== null);
        prev = s;
      });
    }
  });

  test('a candidate: the cap first, then the vehicle clock, then a walk; only one that saw a vehicle leaves the cap record', () => {
    const t0 = T0;
    expect(candidateDue('auto', t0, null, t0, t0 + DETECT.CANDIDATE_CAP_MS, t0 + DETECT.CANDIDATE_CAP_MS, true)).toBe('cap');
    expect(candidateDue('auto', t0, null, t0, t0 + DETECT.CANDIDATE_MAX_MS, null, false)).toBe('timeout');
    expect(candidateDue('auto', t0, null, t0 + 100_000, t0 + 130_000, null, false)).toBe('walking');
    // a vehicle sign before the candidate opened counts from when it opened
    expect(candidateDue('auto', t0, null, null, t0 + DETECT.CANDIDATE_MAX_MS - 1, t0 - 60_000, false)).toBeNull();
    expect(startsAfter([1, 2, 3], 2, true)).toEqual([1, 3]);
    expect(startsAfter([1, 2, 3], 2, false)).toEqual([1, 2, 3]);
    expect(startsAfter([1, 3], 2, true)).toEqual([1, 3]);
  });

  test('a traced start is always a trusted row at or under 3 mph before the run, or a fallback', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rows = randomRows(seed);
      const h = Math.floor(rows.length / 2);
      const s = traceStart(rows, h);
      if (s !== null) {
        expect(s).toBeLessThan(h);
        expect(slow(rows[s]!)).toBe(true);
      }
      const start = startOf(rows, h, 'auto', 0, null);
      expect(start.startSource).toBe(s === null ? 'wake' : 'trace');
    }
  });

  test('a stop shorter than 5 min after driving is never the start', () => {
    for (const stopS of [20, 60, 120, 299]) {
      const rows = [...vrows(0, 30, 0), ...vrows(31, 90, 25), ...vrows(91, 90 + stopS, 0), ...vrows(91 + stopS, 150 + stopS, 25)];
      expect({ stopS, start: traceStart(rows, 91 + stopS) }).toEqual({ stopS, start: 30 });
    }
    const parked = [...vrows(0, 30, 25), ...vrows(31, 331, 0), ...vrows(332, 400, 25)];
    expect(traceStart(parked, 332)).toBe(331);
  });

  test('a departure that crawls (5-14 mph) is never cut at a stop shorter than 5 min: it goes back to the kerb', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const crawl = (from: number, to: number) => vrows(from, to, 0).map((x, i) => vrow(from + i, 5 + r() * 9.9));
      const stopS = 1 + Math.floor(r() * 298);
      const a = 31 + Math.floor(r() * 120);
      const b = a + 1 + stopS;
      const c = b + 1 + Math.floor(r() * 120);
      const rows = [...vrows(0, 30, 0), ...crawl(31, a), ...vrows(a + 1, b, 0), ...crawl(b + 1, c), ...vrows(c + 1, c + 40, 20)];
      expect({ seed, start: traceStart(rows, c + 1) }).toEqual({ seed, start: 30 });
      for (const x of rows) if (x.speed >= 5 * MPS_PER_MPH) expect(rolling(x)).toBe(true);
    }
  });

  test('the still clock restarts at every movement and only fix-less car rows pause it', () => {
    let c = endClockAt(T0);
    for (const row of vrows(0, 20, 30, (s) => ({ northM: s * 13 }))) c = endOnRow(c, row, false);
    expect(c.lastMoveTs).toBe(T0 + 20_000);
    for (const row of vrows(21, 80, 0, { northM: 260 })) c = endOnRow(c, row, true);
    expect(c.holdMs).toBe(0);
    for (const row of vrows(81, 140, null)) c = endOnRow(c, row, true);
    expect(c.holdMs).toBe(60_000);
    expect(endDue(c, T0, T0 + 20_000 + DETECT.STILL_END_MS + 59_999, null).overdue).toBeNull();
    expect(endDue(c, T0, T0 + 20_000 + DETECT.STILL_END_MS + 60_000, null).overdue).toBe('still');
  });

  test('a rest resumed at a relaunch ends no sooner than 5 min after it (nothing over 3 mph) and never past its cap', () => {
    const since = T0;
    const until = T0 + DETECT.SUPPRESS_MAX_MS;
    for (let relaunch = since + 1_000; relaunch < until; relaunch += 7 * 60_000 + 13_000) {
      const moved = suppressionResume(until, relaunch);
      expect(moved).toBe(relaunch);
      const justBefore = Math.min(until, relaunch + DETECT.SUPPRESS_STILL_MS) - 1;
      expect({ relaunch, cause: suppressionDue(since, until, moved, null, justBefore) }).toEqual({ relaunch, cause: null });
      const end = relaunch + DETECT.SUPPRESS_STILL_MS < until ? 'still' : 'cap';
      expect({ relaunch, cause: suppressionDue(since, until, moved, null, Math.min(until, relaunch + DETECT.SUPPRESS_STILL_MS)) }).toEqual({ relaunch, cause: end });
    }
    expect(suppressionResume(until, until)).toBeNull();
    expect(suppressionResume(null, T0)).toBeNull();
  });

  test('distances: 150 m north is 150 m', () => {
    expect(distanceM({ lat: 47.6, lng: -122.33 }, { lat: 47.6 + 150 / ((DETECT.EARTH_RADIUS_M * Math.PI) / 180), lng: -122.33 })).toBeCloseTo(150, 6);
  });
});
