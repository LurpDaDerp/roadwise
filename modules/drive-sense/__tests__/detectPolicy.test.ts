/** @jest-environment node */
// The drive detector's rules (plan §3.3, §3.4, §3.6): every row of the shared decision table holds
// for the TypeScript reference, the numbers agree with the scoring package and the triggers the UI
// quotes, and a few properties hold over generated rows as well as the table's.
import { END_CRAWL_MPH, END_NATIVE_SLACK_S, IDLE_END_S, MERGE_GAP_S, MERGE_RADIUS_M } from '@scoring';

import {
  AUTO_TRIGGER,
  CONFIRM_START,
  confirmStep,
  DETECT,
  distanceM,
  endClockAt,
  endDue,
  endOnRow,
  MANUAL_TRIGGER,
  MPS_PER_MPH,
  slow,
  startOf,
  suppressionDue,
  suppressionResume,
  traceStart,
  trusted,
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
    expect([...kinds].sort()).toEqual(['candidate', 'confirm', 'end', 'motionGate', 'resume', 'start', 'status', 'summary', 'suppress', 'suppressResume', 'trace', 'wake'].sort());
  });
});

describe('the numbers', () => {
  test('the triggers the UI quotes are the ones confirmed', () => {
    expect(DETECT.CONFIRM_MPS_AUTO).toBeCloseTo(AUTO_TRIGGER.mph * MPS_PER_MPH, 9);
    expect(DETECT.CONFIRM_HOLD_MS_AUTO).toBe(AUTO_TRIGGER.holdMs);
    expect(DETECT.CONFIRM_MPS_MANUAL).toBeCloseTo(MANUAL_TRIGGER.mph * MPS_PER_MPH, 9);
    expect(DETECT.CONFIRM_HOLD_MS_MANUAL).toBe(MANUAL_TRIGGER.holdMs);
    for (const t of [AUTO_TRIGGER, MANUAL_TRIGGER]) {
      expect(t.dipMaxMs).toBe(DETECT.CONFIRM_DIP_MAX_MS);
      expect(t.maxHAccM).toBe(DETECT.TRUSTED_HACC_M);
    }
    expect(AUTO_TRIGGER).toEqual({ mph: 15, holdMs: 30_000, dipMaxMs: 5_000, maxHAccM: 30 });
    expect(MANUAL_TRIGGER).toEqual({ mph: 10, holdMs: 15_000, dipMaxMs: 5_000, maxHAccM: 30 });
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
  test('a hold never confirms across a dip spanning more than 5 s, and always spans the hold', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rows = randomRows(seed);
      for (const kind of ['auto', 'manual'] as const) {
        let s = CONFIRM_START;
        for (const row of rows) {
          const step = confirmStep(s, row, kind);
          s = step.state;
          if (!step.confirmed) continue;
          const run = rows.filter((x) => x.ts >= s.runStartTs! && x.ts <= row.ts);
          const mps = kind === 'auto' ? DETECT.CONFIRM_MPS_AUTO : DETECT.CONFIRM_MPS_MANUAL;
          const fast = (x: DetectRow) => trusted(x) && x.speed >= mps;
          expect(fast(run[0]!) && fast(row)).toBe(true);
          expect(row.ts - run[0]!.ts).toBeGreaterThanOrEqual(kind === 'auto' ? DETECT.CONFIRM_HOLD_MS_AUTO : DETECT.CONFIRM_HOLD_MS_MANUAL);
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
    }
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
