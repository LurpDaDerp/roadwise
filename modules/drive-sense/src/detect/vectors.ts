// The drive detector's decision table (plan §3.3). Jest runs every row through the TypeScript
// reference (`policy.ts`, `__tests__/detectPolicy.test.ts`); the phone runs the same rows through
// the Swift policy (`DetectSelfTest.swift`) and the diagnostics screen diffs the answers
// (`selfTest.ts`). Each row names the rule it pins.
import {
  DETECT,
  MPS_PER_MPH,
  type ActivitySample,
  type CandidateCause,
  type CarPort,
  type DetectLastEnd,
  type DetectMissing,
  type DetectRow,
  type DetectStatus,
  type MotionGate,
  type MotionSummary,
  type SafetyCause,
  type SlowReport,
  type StartSource,
  type StatusInputs,
  type TriggerKind,
  type VetoReport,
  type WakeCtx,
  type WakeGate,
} from './policy';

export const T0 = 1_760_000_000_000;
const LAT = 47.6;
const LNG = -122.33;
/** Metres per degree of latitude on the reference sphere. */
const M_PER_DEG = (DETECT.EARTH_RADIUS_M * Math.PI) / 180;
const north = (m: number) => LAT + m / M_PER_DEG;

interface RowOpts {
  /** metres north of the reference point */
  northM?: number;
  hAcc?: number;
  speedAcc?: number;
}

/** A row `sec` seconds after T0 at `mph`; `null` is a row with no fix. */
export function vrow(sec: number, mph: number | null, o: RowOpts = {}): DetectRow {
  const ts = T0 + sec * 1000;
  if (mph === null) return { ts, lat: 0, lng: 0, hAcc: 9999, speed: -1, speedAcc: -1, gnssValid: false };
  return { ts, lat: north(o.northM ?? 0), lng: LNG, hAcc: o.hAcc ?? 5, speed: mph * MPS_PER_MPH, speedAcc: o.speedAcc ?? 0.5, gnssValid: true };
}

/** One row a second from `from` to `to` (both included). */
export function vrows(from: number, to: number, mph: number | null, o: RowOpts | ((sec: number) => RowOpts) = {}): DetectRow[] {
  const out: DetectRow[] = [];
  for (let s = from; s <= to; s++) out.push(vrow(s, mph, typeof o === 'function' ? o(s) : o));
  return out;
}

const at = (sec: number) => T0 + sec * 1000;
const lastEndAt = (decidedSec: number, northM: number): DetectLastEnd => ({
  decidedAt: at(decidedSec),
  cut: at(decidedSec),
  lat: north(northM),
  lng: LNG,
  driveId: '00000000-0000-4000-8000-000000000001',
});

/** A row of the slow-traffic path, or a live motion report arriving between rows. */
export type SlowStep = { row: DetectRow } | { report: SlowReport };

/** A row, or a check at `check` (`waitUntil`: a Start-card drive still waiting for driving speed). */
export type EndStep = { row: DetectRow; automotive: boolean } | { check: number; walkSince: number | null; waitUntil?: number | null };

export interface ExpectedStart {
  index: number;
  startedAt: number;
  startSource: StartSource;
  startLat: number | null;
  startLng: number | null;
  continues: boolean;
}

/**
 * `veto[i]`: a fresh confident cycling, walking or running report at row i; `car[i]`: confident car
 * motion in the last 2 min at row i (both auto only).
 */
export type DetectVector =
  | {
      name: string;
      kind: 'confirm';
      trigger: TriggerKind;
      rows: DetectRow[];
      veto: boolean[];
      car: boolean[];
      expected: { confirmedAt: number | null; runStartTs: number | null };
    }
  | { name: string; kind: 'trace'; rows: DetectRow[]; h: number; expected: { index: number | null } }
  /**
   * The slow-traffic path over rows and live reports in arrival order: where it confirmed, its run's
   * start, the trace-back from there over the rows so far, and the car motion banked by the
   * confirming row (else by the last step).
   */
  | {
      name: string;
      kind: 'slow';
      steps: SlowStep[];
      expected: { confirmedAt: number | null; runStartTs: number | null; traced: number | null; carMs: number };
    }
  /** The car link start: `link[i]` a paired car or CarPlay current at row i, `veto[i]` and `car[i]` as for 'confirm'. */
  | {
      name: string;
      kind: 'link';
      rows: DetectRow[];
      link: boolean[];
      veto: boolean[];
      car: boolean[];
      expected: { confirmedAt: number | null; runStartTs: number | null };
    }
  /** The link's match over the route's outputs, and "most of the drive" for an output current `withRows` of `rows`. */
  | { name: string; kind: 'car'; current: CarPort[]; paired: string[]; withRows: number; rows: number; expected: { linked: boolean; most: boolean } }
  | {
      name: string;
      kind: 'start';
      trigger: TriggerKind;
      rows: DetectRow[];
      car: boolean[];
      automotiveSince: number;
      lastEnd: DetectLastEnd | null;
      expected: { confirmedAt: number | null; start: ExpectedStart | null };
    }
  | { name: string; kind: 'summary'; activities: ActivitySample[]; now: number; expected: MotionSummary }
  | { name: string; kind: 'motionGate'; summary: MotionSummary; now: number; expected: MotionGate }
  /** The live reports in arrival order, then the on-foot veto at `now`. */
  | { name: string; kind: 'veto'; reports: VetoReport[]; now: number; expected: boolean }
  | { name: string; kind: 'wake'; ctx: WakeCtx; expected: WakeGate }
  | {
      name: string;
      kind: 'candidate';
      trigger: TriggerKind;
      since: number;
      waitUntil: number | null;
      walkSince: number | null;
      now: number;
      lastVehicleTs: number | null;
      hasEvidence: boolean;
      expected: CandidateCause | null;
    }
  | { name: string; kind: 'startsAfter'; starts: number[]; since: number; sawVehicle: boolean; expected: number[] }
  | {
      name: string;
      kind: 'end';
      startedAt: number;
      steps: EndStep[];
      /** `linger` (`lingerAfterJsEnd`: a JS end at that check opens the linger) is checked only where given. */
      expected: { due: SafetyCause | null; overdue: SafetyCause | null; linger?: boolean }[];
    }
  | {
      name: string;
      kind: 'suppress';
      since: number;
      until: number;
      lastOverStopTs: number | null;
      walkSince: number | null;
      now: number;
      expected: 'cap' | 'walking' | 'still' | null;
    }
  | {
      name: string;
      kind: 'suppressResume';
      since: number;
      until: number;
      relaunch: number;
      /** Times the rest's clock checks after the relaunch (no fix over 3 mph, no walk). */
      checks: number[];
      expected: { resumed: boolean; causes: ('cap' | 'walking' | 'still' | null)[] };
    }
  | { name: string; kind: 'resume'; lastRowTs: number | null; startedAt: number; now: number; expected: 'resume' | 'orphan' }
  | { name: string; kind: 'resumeSeq'; topSeq: number; expected: number }
  | { name: string; kind: 'status'; inputs: StatusInputs; expected: { status: DetectStatus; missing: DetectMissing[] } };

type Flag = boolean | ((sec: number) => boolean);
const flags = (rows: DetectRow[], f: Flag = false) => rows.map((r) => (typeof f === 'function' ? f((r.ts - T0) / 1000) : f));

/** The rows with a flag per row: `veto` (a fresh walk, run or ride report) and `car` (fresh car motion), both off by default. */
const confirmRows = (rows: DetectRow[], o: { veto?: Flag; car?: Flag } = {}) => ({ rows, veto: flags(rows, o.veto), car: flags(rows, o.car) });

const kerb = [...vrows(0, 60, 0), vrow(61, 5), vrow(62, 8), vrow(63, 12), vrow(64, 14), ...vrows(65, 100, 21)];

/**
 * Heavy city traffic: parked 30 s, then `cycles` minutes of 30 s stopped at a light, 10 s at 8 mph,
 * 6 s at 18.5 mph (a 19.17 s hold), 10 s at 10 mph and 4 s at 5 mph. Only the 18.5 mph rows earn,
 * and only with car motion; each minute adds 5/19.17 of the evidence, so it confirms on the 4th
 * burst's 6th row (t = 255 s).
 */
function stopAndGo(cycles: number): DetectRow[] {
  const out = vrows(0, 29, 0);
  for (let c = 0; c < cycles; c++) {
    const t = 30 + c * 60;
    out.push(...vrows(t, t + 29, 0), ...vrows(t + 30, t + 39, 8), ...vrows(t + 40, t + 45, 18.5), ...vrows(t + 46, t + 55, 10), ...vrows(t + 56, t + 59, 5));
  }
  return out;
}

/** From the kerb, a crawl at 8 mph, a 45 s red light, then 24 mph (a 10 s hold). */
const kerbRedLight = [...vrows(0, 30, 0), ...vrows(31, 50, 8), ...vrows(51, 95, 0), ...vrows(96, 140, 24)];

const act = (start: number, o: Partial<ActivitySample>): ActivitySample => ({ start, automotive: false, stationary: false, onFoot: false, confident: true, ...o });

/** A live report arriving `sec` s after T0: confident and neither on foot nor automotive (a stationary phone) unless told. */
const report = (sec: number, o: Partial<VetoReport> = {}): VetoReport => ({ at: at(sec), onFoot: false, automotive: false, confident: true, ...o });
const onFoot = (sec: number, confident = true) => report(sec, { onFoot: true, confident });
const car = (sec: number, confident = true) => report(sec, { automotive: true, confident });

const wakeCtx = (o: Partial<WakeCtx> = {}): WakeCtx => ({
  now: at(0),
  reason: 'slc',
  phase: 'armed',
  armed: true,
  hasOwner: true,
  permissionsOk: true,
  candidateRestUntil: 0,
  candidateStarts: [],
  ...o,
});

const statusIn = (o: Partial<StatusInputs> = {}): StatusInputs => ({
  armed: true,
  hardware: true,
  location: 'always',
  precise: true,
  motion: 'granted',
  backgroundRefresh: 'available',
  liveActivities: true,
  ...o,
});

const steps = (rows: DetectRow[], automotive = false): EndStep[] => rows.map((row) => ({ row, automotive }));
const check = (sec: number, walkSec: number | null = null, waitSec?: number): EndStep => ({
  check: at(sec),
  walkSince: walkSec === null ? null : at(walkSec),
  ...(waitSec === undefined ? {} : { waitUntil: at(waitSec) }),
});
const none = { due: null, overdue: null };

/** A live report for the slow-traffic path `sec` s after T0: confident moving car motion unless told. */
const carAt = (sec: number, o: Partial<SlowReport> = {}): SlowReport => ({ at: at(sec), automotive: true, stationary: false, onFoot: false, confident: true, ...o });
const footAt = (sec: number): SlowReport => carAt(sec, { automotive: false, onFoot: true });

/** Rows and live reports in arrival order (a report goes before the row of its second). */
function slowSteps(rows: readonly DetectRow[], reports: readonly SlowReport[] = []): SlowStep[] {
  const sorted = [...reports].sort((a, b) => a.at - b.at);
  const out: SlowStep[] = [];
  let i = 0;
  for (const row of rows) {
    while (i < sorted.length && sorted[i]!.at <= row.ts) out.push({ report: sorted[i++]! });
    out.push({ row });
  }
  while (i < sorted.length) out.push({ report: sorted[i++]! });
  return out;
}

/** One row a second from `from` to `to` at `mph`, heading north from `startM` at that speed. */
const northRows = (from: number, to: number, mph: number, startM = 0): DetectRow[] => vrows(from, to, mph, (s) => ({ northM: startM + mph * MPS_PER_MPH * (s - from) }));

/** 4.4704 m: a second at 10 mph. */
const M10 = 10 * MPS_PER_MPH;

/** From the kerb (31 s parked) at 10 mph, north. */
const kerb10 = [...vrows(0, 30, 0), ...northRows(31, 400, 10, M10)];

/**
 * Stop and go at 12 mph: parked 10 s, then per 30 s a 20 s roll (a car motion report as it sets
 * off, 107.3 m) and 10 s at a light (a report of the car standing). The path passes 800 m on the
 * 10th rolling row of the 8th roll (t = 229 s); by then 149 s of car motion stand.
 */
function slowStopAndGo(cycles: number): SlowStep[] {
  const v = 12 * MPS_PER_MPH;
  const rows: DetectRow[] = vrows(0, 9, 0);
  const reports: SlowReport[] = [];
  let m = 0;
  for (let c = 0; c < cycles; c++) {
    const t = 10 + c * 30;
    reports.push(carAt(t), carAt(t + 20, { stationary: true }));
    rows.push(...northRows(t, t + 19, 12, m + v), ...vrows(t + 20, t + 29, 0, { northM: m + 20 * v }));
    m += 20 * v;
  }
  return slowSteps(rows, reports);
}

/** Back and forth between two points 300 m apart at 10 mph (a car park): the path grows, the net never passes 300 m. */
const carPark = vrows(0, 600, 10, (s) => {
  const p = (M10 * s) % 600;
  return { northM: p <= 300 ? p : 600 - p };
});

/** The link flags per row (`link` on by default), with `veto` and `car` as for 'confirm'. */
const linkRows = (rows: DetectRow[], o: { link?: Flag; veto?: Flag; car?: Flag } = {}) => ({ rows, link: flags(rows, o.link ?? true), veto: flags(rows, o.veto), car: flags(rows, o.car) });

export const DETECT_VECTORS: readonly DetectVector[] = [
  // ——— confirmation ———
  // The auto trigger: the hold a speed needs is (5/3)·(30 − mph) s over 15 mph (25 s just over it,
  // 20 s at 18, 15 s at 21, 10 s at 24, 5 s at 27, 0 at 30), never under 0.9 s, so from about
  // 29.46 mph a drive confirms on the second reading in a row, the 1 Hz timer's jitter included;
  // each interval between two earning rows earns at the slower one's rate.
  { name: 'auto: 15.0 mph never confirms, even with fresh car motion', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 120, 15), { car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: just over 15 mph (15.01) with car motion confirms at 25 s (a 24.98 s hold)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 15.01), { car: true }), expected: { confirmedAt: at(25), runStartTs: at(0) } },
  { name: 'auto: 16 mph with car motion confirms at 24 s (a 23.3 s hold)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 16), { car: true }), expected: { confirmedAt: at(24), runStartTs: at(0) } },
  { name: 'auto: 16 mph held a minute without fresh car motion never confirms', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 16)), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: 17 mph without car motion never confirms (a bike)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 120, 17)), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: 18 mph with car motion confirms after 20 s', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 18), { car: true }), expected: { confirmedAt: at(20), runStartTs: at(0) } },
  { name: 'auto: 20 mph confirms at 17 s (a 16.7 s hold), car motion or not', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 20)), expected: { confirmedAt: at(17), runStartTs: at(0) } },
  { name: 'auto: 21 mph confirms after 15 s', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 21)), expected: { confirmedAt: at(15), runStartTs: at(0) } },
  { name: 'auto: 22 mph without car motion confirms at 14 s (a 13.3 s hold)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 22)), expected: { confirmedAt: at(14), runStartTs: at(0) } },
  { name: 'auto: 24 mph confirms after 10 s', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 24)), expected: { confirmedAt: at(10), runStartTs: at(0) } },
  { name: 'auto: 27 mph confirms after 5 s', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 27)), expected: { confirmedAt: at(5), runStartTs: at(0) } },
  { name: 'auto: 29 mph confirms at 2 s (a 1.7 s hold)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 29)), expected: { confirmedAt: at(2), runStartTs: at(0) } },
  { name: 'auto: 29.5 mph confirms on the second reading (the 0.9 s floor)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 29.5)), expected: { confirmedAt: at(1), runStartTs: at(0) } },
  { name: 'auto: 30 mph confirms on the second reading, never the first', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 30)), expected: { confirmedAt: at(1), runStartTs: at(0) } },
  { name: 'auto: 45 mph confirms on the second reading too', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 45)), expected: { confirmedAt: at(1), runStartTs: at(0) } },
  { name: 'auto: 40 mph readings 997 ms apart (timer jitter) confirm on the second', kind: 'confirm', trigger: 'auto', ...confirmRows([vrow(0, 40), vrow(0.997, 40), vrow(1.995, 40)]), expected: { confirmedAt: at(0.997), runStartTs: at(0) } },
  { name: 'auto: 30 mph readings 960 ms apart confirm on the second', kind: 'confirm', trigger: 'auto', ...confirmRows([vrow(0, 30), vrow(0.96, 30), vrow(1.96, 30)]), expected: { confirmedAt: at(0.96), runStartTs: at(0) } },
  { name: 'auto: two 40 mph readings 850 ms apart do not confirm (under the floor), the third does', kind: 'confirm', trigger: 'auto', ...confirmRows([vrow(0, 40), vrow(0.85, 40), vrow(1.85, 40)]), expected: { confirmedAt: at(1.85), runStartTs: at(0) } },
  { name: 'auto: alternating 21 and 30 mph earns at 21 mph (the slower end of each interval)', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 21).map((r, i) => (i % 2 === 1 ? vrow(i, 30) : r))), expected: { confirmedAt: at(15), runStartTs: at(0) } },
  { name: 'auto: 14 mph never confirms, even with car motion', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 120, 14), { car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: a lone 40 mph spike never confirms', kind: 'confirm', trigger: 'auto', ...confirmRows([vrow(0, 40)], { car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: two 40 mph readings 3 s apart never confirm (the gap earns nothing)', kind: 'confirm', trigger: 'auto', ...confirmRows([vrow(0, 40), vrow(3, 40)], { car: true }), expected: { confirmedAt: null, runStartTs: null } },
  {
    name: 'auto: a single 40 mph GPS spike among stopped rows does not confirm',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 20, 0), vrow(21, 40), ...vrows(22, 60, 0)], { car: true }),
    expected: { confirmedAt: null, runStartTs: null },
  },
  {
    name: 'auto: a single 40 mph GPS spike in 10 mph traffic does not confirm',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 20, 10), vrow(21, 40), ...vrows(22, 60, 10)], { car: true }),
    expected: { confirmedAt: null, runStartTs: null },
  },
  {
    name: 'auto: slow city traffic, 5-20 mph stop and go over 15 min with car motion, confirms on the 4th burst',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows(stopAndGo(15), { car: true }),
    expected: { confirmedAt: at(255), runStartTs: at(70) },
  },
  { name: 'auto: the same stop and go without car motion never confirms (a bike)', kind: 'confirm', trigger: 'auto', ...confirmRows(stopAndGo(15)), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: a cyclist at 16 mph with a cycling report never confirms', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 300, 16), { veto: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: a rider the phone reads as cycling earns nothing at 24 mph either', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 300, 24), { veto: true, car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: a runner never confirms', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 600, 12), { veto: true }), expected: { confirmedAt: null, runStartTs: null } },
  {
    name: 'auto: a fresh cycling report earns nothing for the intervals it touches',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows(vrows(0, 40, 21), { veto: (s) => s === 10 || s === 11 }),
    expected: { confirmedAt: at(18), runStartTs: at(0) },
  },
  {
    name: 'auto: 10 s at 21 mph, a 299 s stop, then 21 mph confirms 6 s into the second run (the evidence kept)',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 9, 21), ...vrows(10, 308, 0), ...vrows(309, 400, 21)]),
    expected: { confirmedAt: at(315), runStartTs: at(0) },
  },
  {
    name: 'auto: evidence is forgotten after 5 min with no movement: after a 300 s stop it takes 15 s again',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 9, 21), ...vrows(10, 309, 0), ...vrows(310, 400, 21)]),
    expected: { confirmedAt: at(325), runStartTs: at(310) },
  },
  {
    name: 'auto: crawling keeps the evidence through a 6 min jam',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 9, 21), ...vrows(10, 369, 6), ...vrows(370, 400, 21)]),
    expected: { confirmedAt: at(376), runStartTs: at(0) },
  },
  { name: 'auto: 10 s at 21 mph then a stop does not confirm', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 9, 21), ...vrows(10, 60, 0)]), expected: { confirmedAt: null, runStartTs: null } },
  {
    name: 'auto: a row with a 50 m fix earns nothing for its two intervals; what was earned stays',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 4, 21), vrow(5, 21, { hAcc: 50 }), ...vrows(6, 40, 21)]),
    expected: { confirmedAt: at(17), runStartTs: at(0) },
  },
  {
    name: 'auto: a 4 s gap between readings earns nothing for itself',
    kind: 'confirm',
    trigger: 'auto',
    ...confirmRows([...vrows(0, 4, 21), ...vrows(8, 40, 21)]),
    expected: { confirmedAt: at(19), runStartTs: at(0) },
  },
  { name: 'auto: rows with no fix earn nothing', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 4, 21), ...vrows(5, 7, null), ...vrows(8, 40, 21)]), expected: { confirmedAt: at(19), runStartTs: at(0) } },
  { name: 'auto: a speed rated worse than 2 m/s never counts', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 21, { speedAcc: 3 })), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: an unrated speed counts', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 21, { speedAcc: -1 })), expected: { confirmedAt: at(15), runStartTs: at(0) } },
  { name: 'manual: 10 mph held 15 s confirms', kind: 'confirm', trigger: 'manual', ...confirmRows(vrows(0, 20, 12)), expected: { confirmedAt: at(15), runStartTs: at(0) } },
  { name: 'manual: 8 mph never confirms', kind: 'confirm', trigger: 'manual', ...confirmRows(vrows(0, 40, 8)), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'manual: a dip under 10 mph spanning 5 s keeps the hold', kind: 'confirm', trigger: 'manual', ...confirmRows([...vrows(0, 2, 12), ...vrows(3, 8, 6), ...vrows(9, 40, 12)]), expected: { confirmedAt: at(15), runStartTs: at(0) } },
  { name: 'manual: a dip spanning 6 s breaks the hold; the next run starts after it', kind: 'confirm', trigger: 'manual', ...confirmRows([...vrows(0, 2, 12), ...vrows(3, 9, 6), ...vrows(10, 60, 12)]), expected: { confirmedAt: at(25), runStartTs: at(10) } },
  { name: 'manual: rows with no fix are a dip', kind: 'confirm', trigger: 'manual', ...confirmRows([...vrows(0, 2, 12), ...vrows(3, 6, null), ...vrows(7, 40, 12)]), expected: { confirmedAt: at(15), runStartTs: at(0) } },

  // ——— the trace-back ———
  { name: 'trace: a car at the kerb starts at its last stopped row', kind: 'trace', rows: kerb, h: 65, expected: { index: 60 } },
  {
    name: 'trace: a red light inside the rise does not move the start',
    kind: 'trace',
    rows: [...vrows(0, 30, 0), ...vrows(31, 60, 20), ...vrows(61, 100, 0), ...vrows(101, 140, 20)],
    h: 101,
    expected: { index: 30 },
  },
  {
    name: 'trace: two short stops inside the rise go back to the kerb',
    kind: 'trace',
    rows: [...vrows(0, 10, 0), ...vrows(11, 40, 20), ...vrows(41, 60, 0), ...vrows(61, 70, 20), ...vrows(71, 90, 0), ...vrows(91, 120, 20)],
    h: 91,
    expected: { index: 10 },
  },
  {
    name: 'trace: a stop of 5 min or more before the rise is where the car was parked',
    kind: 'trace',
    rows: [...vrows(0, 30, 20), ...vrows(31, 340, 0), ...vrows(341, 400, 20)],
    h: 341,
    expected: { index: 340 },
  },
  { name: 'trace: rows that begin moving have no traced start', kind: 'trace', rows: vrows(0, 60, 20), h: 30, expected: { index: null } },
  { name: 'trace: a crawl between the kerb and the rise belongs to the rise', kind: 'trace', rows: [...vrows(0, 20, 0), ...vrows(21, 30, 6), ...vrows(31, 80, 20)], h: 31, expected: { index: 20 } },
  { name: 'trace: a stopped row with a poor fix is not a stop', kind: 'trace', rows: [...vrows(0, 20, 0), ...vrows(21, 25, 0, { hAcc: 80 }), ...vrows(26, 60, 20)], h: 26, expected: { index: 20 } },
  {
    name: 'trace: a departure that only crawled (8 mph) before a stop goes back over the stop to the kerb',
    kind: 'trace',
    rows: [...vrows(0, 60, 0), ...vrows(61, 120, 8), ...vrows(121, 160, 0), ...vrows(161, 190, 8), ...vrows(191, 260, 20)],
    h: 191,
    expected: { index: 60 },
  },
  {
    name: 'trace: walking pace (4 mph) before a stop is not the car rolling',
    kind: 'trace',
    rows: [...vrows(0, 20, 0), ...vrows(21, 40, 4), ...vrows(41, 60, 0), ...vrows(61, 100, 20)],
    h: 61,
    expected: { index: 60 },
  },

  // ——— the start (confirmation, trace-back, fallbacks, the warm-up hint) ———
  {
    name: 'start: a kerb departure starts at the kerb, placed there',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(kerb),
    automotiveSince: 0,
    lastEnd: null,
    expected: { confirmedAt: at(80), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: from the kerb through a red light, the drive starts at the kerb',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(kerbRedLight),
    automotiveSince: 0,
    lastEnd: null,
    expected: { confirmedAt: at(106), start: { index: 30, startedAt: at(30), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: slow city traffic confirmed on its 4th burst starts where the car first moved',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(stopAndGo(15), { car: true }),
    automotiveSince: 0,
    lastEnd: null,
    expected: { confirmedAt: at(255), start: { index: 59, startedAt: at(59), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: rows that begin moving start at the car motion, at the parked spot it could have come from',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(vrows(0, 40, 21, (s) => ({ northM: 500 + 9 * s }))),
    automotiveSince: at(-60),
    lastEnd: lastEndAt(-600, 0),
    expected: { confirmedAt: at(15), start: { index: 0, startedAt: at(-60), startSource: 'motion', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: the motion start is not placed at a parked spot it could not have come from',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(vrows(0, 40, 21, (s) => ({ northM: 500 + 9 * s }))),
    automotiveSince: at(-60),
    lastEnd: lastEndAt(-600, -5000),
    expected: { confirmedAt: at(15), start: { index: 0, startedAt: at(-60), startSource: 'motion', startLat: null, startLng: null, continues: false } },
  },
  {
    name: 'start: without car motion before it, the first row starts the drive',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(vrows(0, 40, 21, (s) => ({ northM: 9 * s }))),
    automotiveSince: 0,
    lastEnd: null,
    expected: { confirmedAt: at(15), start: { index: 0, startedAt: at(0), startSource: 'wake', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: a Start-card drive never uses the motion start',
    kind: 'start',
    trigger: 'manual',
    ...confirmRows(vrows(0, 20, 12)),
    automotiveSince: at(-60),
    lastEnd: null,
    expected: { confirmedAt: at(15), start: { index: 0, startedAt: at(0), startSource: 'wake', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: a start 60 s after the last end and 50 m from it continues it',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(kerb),
    automotiveSince: 0,
    lastEnd: lastEndAt(0, -50),
    expected: { confirmedAt: at(80), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: true } },
  },
  {
    name: 'start: 6 min after the last end is a new drive',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(kerb),
    automotiveSince: 0,
    lastEnd: lastEndAt(-300, -50),
    expected: { confirmedAt: at(80), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: 200 m from the last end is a new drive',
    kind: 'start',
    trigger: 'auto',
    ...confirmRows(kerb),
    automotiveSince: 0,
    lastEnd: lastEndAt(0, -200),
    expected: { confirmedAt: at(80), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  { name: 'start: no confirmation, no start', kind: 'start', trigger: 'auto', ...confirmRows(vrows(0, 60, 12)), automotiveSince: 0, lastEnd: null, expected: { confirmedAt: null, start: null } },

  // ——— slow traffic: 90 s of car motion, an 800 m path 400 m from where it began, 8 mph on average, never on foot ———
  {
    name: 'slow: a 10 mph car with car motion confirms once its path passes 800 m, and starts at the kerb',
    kind: 'slow',
    steps: slowSteps(kerb10, [carAt(31)]),
    expected: { confirmedAt: at(209), runStartTs: at(31), traced: 30, carMs: 178_000 },
  },
  {
    name: 'slow: stop and go at 12 mph (car motion only while rolling) confirms on the 8th roll and starts where the car first moved',
    kind: 'slow',
    steps: slowStopAndGo(12),
    expected: { confirmedAt: at(229), runStartTs: at(10), traced: 9, carMs: 149_000 },
  },
  {
    name: 'slow: 80 s of car motion is not enough; it confirms once more car motion makes 90 s',
    kind: 'slow',
    steps: slowSteps(kerb10, [carAt(31), carAt(111, { stationary: true }), carAt(300)]),
    expected: { confirmedAt: at(310), runStartTs: at(31), traced: 30, carMs: 90_000 },
  },
  {
    name: 'slow: 5 min with nothing over 3 mph forgets the path and the car motion; the next 800 m start after the stop',
    kind: 'slow',
    steps: slowSteps([...northRows(0, 99, 10), ...vrows(100, 399, 0, { northM: 99 * M10 }), ...northRows(400, 700, 10, 100 * M10)], [carAt(0), carAt(100, { stationary: true }), carAt(400)]),
    expected: { confirmedAt: at(578), runStartTs: at(400), traced: 399, carMs: 178_000 },
  },
  { name: 'slow: a walk at 3 mph with no car motion never confirms', kind: 'slow', steps: slowSteps(northRows(0, 1200, 3)), expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 0 } },
  {
    name: 'slow: a walk at 4 mph with a walking report never confirms, even after a misread car report',
    kind: 'slow',
    steps: slowSteps(northRows(0, 1200, 4), [carAt(0), footAt(30)]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 30_000 },
  },
  {
    name: 'slow: a bike at 12 mph with a cycling report never confirms, whatever car motion the phone misreads',
    kind: 'slow',
    steps: slowSteps(northRows(0, 900, 12), [carAt(0), footAt(60), carAt(120)]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 840_000 },
  },
  { name: 'slow: a bike at 12 mph with no car motion never confirms', kind: 'slow', steps: slowSteps(northRows(0, 900, 12)), expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 0 } },
  {
    name: 'slow: a walk to the car since the candidate opened stops the slow path for good',
    kind: 'slow',
    steps: slowSteps(kerb10, [footAt(5), carAt(31)]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 369_000 },
  },
  {
    name: 'slow: a car-park loop never 400 m from where it began never confirms, however long its path',
    kind: 'slow',
    steps: slowSteps(carPark, [carAt(0)]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 600_000 },
  },
  {
    name: 'slow: a short car move (350 m) then a stop never confirms',
    kind: 'slow',
    steps: slowSteps([...vrows(0, 10, 0), ...northRows(11, 88, 10, M10), ...vrows(89, 300, 0, { northM: 78 * M10 })], [carAt(11), carAt(89, { stationary: true })]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 78_000 },
  },
  {
    name: 'slow: a 6 mph crawl (under the 8 mph average) never confirms',
    kind: 'slow',
    steps: slowSteps(northRows(0, 600, 6), [carAt(0)]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 600_000 },
  },
  {
    name: 'slow: low-confidence car motion earns no car time',
    kind: 'slow',
    steps: slowSteps(kerb10, [carAt(31, { confident: false })]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 0 },
  },
  {
    name: 'slow: a parked car\'s GPS wander adds no path',
    kind: 'slow',
    steps: slowSteps(vrows(0, 600, 0, (s) => ({ northM: (s * 37) % 25 })), [carAt(0)]),
    expected: { confirmedAt: null, runStartTs: null, traced: null, carMs: 600_000 },
  },

  // ——— the car link: a paired car's audio or CarPlay current, two trusted rows at 5 mph or more ———
  {
    name: 'link: the paired car connected, two trusted rows at 5 mph with car motion confirm from the kerb',
    kind: 'link',
    ...linkRows([...vrows(0, 10, 0), ...vrows(11, 30, 6)], { car: true }),
    expected: { confirmedAt: at(12), runStartTs: at(11) },
  },
  { name: 'link: 4 mph is not enough', kind: 'link', ...linkRows(vrows(0, 60, 4), { car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'link: without car motion 12 mph is not enough (headphones on a bike)', kind: 'link', ...linkRows(vrows(0, 60, 12)), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'link: without car motion, at 16 mph two rows confirm', kind: 'link', ...linkRows(vrows(0, 60, 16)), expected: { confirmedAt: at(1), runStartTs: at(0) } },
  { name: 'link: an on-foot veto holds it (headphones on a ride or a walk)', kind: 'link', ...linkRows(vrows(0, 60, 16), { veto: true, car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'link: with no paired car or CarPlay current it never confirms', kind: 'link', ...linkRows(vrows(0, 60, 20), { link: false, car: true }), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'link: a row with no fix breaks the pair', kind: 'link', ...linkRows([vrow(0, 6), vrow(1, null), vrow(2, 6), vrow(3, 6)], { car: true }), expected: { confirmedAt: at(3), runStartTs: at(2) } },
  { name: 'link: two rows 3 s apart are not in a row', kind: 'link', ...linkRows([vrow(0, 6), vrow(3, 6), vrow(4, 6)], { car: true }), expected: { confirmedAt: at(4), runStartTs: at(3) } },
  {
    name: 'link: the link dropping between two rows breaks the pair (a route flap)',
    kind: 'link',
    ...linkRows(vrows(0, 5, 8), { car: true, link: (s) => s !== 1 }),
    expected: { confirmedAt: at(3), runStartTs: at(2) },
  },
  {
    name: 'car: a paired car among several outputs links, matched on its uid; 61 of 120 rows is most of a drive',
    kind: 'car',
    current: [
      { uid: '00:11:22:33:44:55-tacl', type: 'bluetoothA2DP' },
      { uid: 'AA:BB:CC:DD:EE:FF-tacl', type: 'bluetoothLE' },
    ],
    paired: ['AA:BB:CC:DD:EE:FF-tacl'],
    withRows: 61,
    rows: 120,
    expected: { linked: true, most: true },
  },
  { name: 'car: CarPlay links unpaired; half the rows is not most', kind: 'car', current: [{ uid: 'carplay-1', type: 'carAudio' }], paired: [], withRows: 60, rows: 120, expected: { linked: true, most: false } },
  {
    name: 'car: an unpaired Bluetooth output does not link; a drive under 2 min has no outputs',
    kind: 'car',
    current: [{ uid: 'x', type: 'bluetoothA2DP' }],
    paired: ['y'],
    withRows: 119,
    rows: 119,
    expected: { linked: false, most: false },
  },
  { name: 'car: nothing connected does not link', kind: 'car', current: [], paired: ['y'], withRows: 0, rows: 0, expected: { linked: false, most: false } },

  // ——— the motion history and the wake ———
  { name: 'summary: car motion until now', kind: 'summary', activities: [act(at(-600), { automotive: true })], now: at(0), expected: { lastAutomotiveAt: at(0), automotiveSince: at(-600), onFootNow: false } },
  {
    name: 'summary: a walk after the drive',
    kind: 'summary',
    activities: [act(at(-900), { automotive: true }), act(at(-60), { onFoot: true })],
    now: at(0),
    expected: { lastAutomotiveAt: at(-60), automotiveSince: at(-900), onFootNow: true },
  },
  { name: 'summary: a car standing still is no car motion', kind: 'summary', activities: [act(at(-60), { automotive: true, stationary: true })], now: at(0), expected: { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false } },
  { name: 'summary: low-confidence car motion does not count', kind: 'summary', activities: [act(at(-60), { automotive: true, confident: false })], now: at(0), expected: { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false } },
  {
    name: 'summary: 30 min without car motion starts a new run',
    kind: 'summary',
    activities: [act(at(-10_800), { automotive: true }), act(at(-10_200), { stationary: true }), act(at(-600), { automotive: true })],
    now: at(0),
    expected: { lastAutomotiveAt: at(0), automotiveSince: at(-600), onFootNow: false },
  },
  { name: 'motion gate: car motion a minute ago passes', kind: 'motionGate', summary: { lastAutomotiveAt: at(-60), automotiveSince: at(-600), onFootNow: false }, now: at(0), expected: 'ok' },
  { name: 'motion gate: car motion 3 min ago is not fresh', kind: 'motionGate', summary: { lastAutomotiveAt: at(-180), automotiveSince: at(-600), onFootNow: false }, now: at(0), expected: 'notFresh' },
  { name: 'motion gate: no car motion is not fresh', kind: 'motionGate', summary: { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false }, now: at(0), expected: 'notFresh' },
  { name: 'motion gate: a driver on foot now starts nothing', kind: 'motionGate', summary: { lastAutomotiveAt: at(-30), automotiveSince: at(-600), onFootNow: true }, now: at(0), expected: 'onFoot' },
  { name: 'veto: a confident walk 10 s ago holds', kind: 'veto', reports: [onFoot(-10)], now: at(0), expected: true },
  { name: 'veto: a confident ride exactly 30 s ago still holds', kind: 'veto', reports: [onFoot(-30)], now: at(0), expected: true },
  { name: 'veto: a confident ride 31 s ago no longer holds', kind: 'veto', reports: [onFoot(-31)], now: at(0), expected: false },
  { name: 'veto: a low-confidence walk vetoes nothing', kind: 'veto', reports: [onFoot(-5, false)], now: at(0), expected: false },
  { name: 'veto: a confident ride then a low-confidence report keeps it', kind: 'veto', reports: [onFoot(-10), report(-5, { confident: false })], now: at(0), expected: true },
  { name: 'veto: a confident ride then a stationary report keeps it', kind: 'veto', reports: [onFoot(-10), report(-5)], now: at(0), expected: true },
  { name: 'veto: a confident ride then a low-confidence automotive report keeps it', kind: 'veto', reports: [onFoot(-10), car(-5, false)], now: at(0), expected: true },
  { name: 'veto: a confident automotive report after the walk lifts it (the car pulling away, or standing at a light)', kind: 'veto', reports: [onFoot(-10), car(-5)], now: at(0), expected: false },
  { name: 'veto: a car report before the walk lifts nothing', kind: 'veto', reports: [car(-20), onFoot(-10)], now: at(0), expected: true },
  { name: 'veto: a later confident walk vetoes again after a car report', kind: 'veto', reports: [onFoot(-25), car(-20), onFoot(-5)], now: at(0), expected: true },
  { name: 'veto: no report vetoes nothing', kind: 'veto', reports: [], now: at(0), expected: false },
  { name: 'wake: armed, owned, allowed and idle passes', kind: 'wake', ctx: wakeCtx(), expected: 'ok' },
  { name: 'wake: not armed', kind: 'wake', ctx: wakeCtx({ armed: false }), expected: 'off' },
  { name: 'wake: no owner', kind: 'wake', ctx: wakeCtx({ hasOwner: false }), expected: 'noOwner' },
  { name: 'wake: a permission is missing', kind: 'wake', ctx: wakeCtx({ permissionsOk: false }), expected: 'permission' },
  { name: 'wake: a drive is recording', kind: 'wake', ctx: wakeCtx({ phase: 'recording' }), expected: 'busy' },
  { name: 'wake: suppressed after "Not driving?"', kind: 'wake', ctx: wakeCtx({ phase: 'suppressed' }), expected: 'busy' },
  { name: 'wake: a significant change rests after a timed-out candidate', kind: 'wake', ctx: wakeCtx({ candidateRestUntil: at(60) }), expected: 'resting' },
  { name: 'wake: a region exit ignores the rest', kind: 'wake', ctx: wakeCtx({ reason: 'region', candidateRestUntil: at(60) }), expected: 'ok' },
  { name: 'wake: RoadWise coming to the front ignores the rest', kind: 'wake', ctx: wakeCtx({ reason: 'app', candidateRestUntil: at(60) }), expected: 'ok' },
  { name: 'wake: a visit rests too', kind: 'wake', ctx: wakeCtx({ reason: 'visit', candidateRestUntil: at(60) }), expected: 'resting' },
  { name: 'wake: RoadWise coming to the front still meets the cap', kind: 'wake', ctx: wakeCtx({ reason: 'app', candidateStarts: [-3000, -2500, -2000, -1500, -1000, -500].map(at) }), expected: 'capped' },
  { name: 'wake: six candidates in the hour is the cap', kind: 'wake', ctx: wakeCtx({ reason: 'region', candidateStarts: [-3000, -2500, -2000, -1500, -1000, -500].map(at) }), expected: 'capped' },
  { name: 'wake: candidates older than an hour do not count', kind: 'wake', ctx: wakeCtx({ candidateStarts: [-7200, -3600, -2000, -1500, -1000, -500].map(at) }), expected: 'ok' },

  // ——— a candidate's clock and the hourly cap ———
  { name: 'candidate: an auto candidate that sees no vehicle ends at 3 min', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(180), lastVehicleTs: null, hasEvidence: false, expected: 'timeout' },
  { name: 'candidate: an auto candidate runs at 2:59', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(179), lastVehicleTs: null, hasEvidence: false, expected: null },
  { name: 'candidate: a vehicle sign keeps it open 3 min past the sign', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(279), lastVehicleTs: at(100), hasEvidence: false, expected: null },
  { name: 'candidate: 3 min after the last vehicle sign it ends', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(280), lastVehicleTs: at(100), hasEvidence: false, expected: 'timeout' },
  { name: 'candidate: with evidence it waits 5 min past the last vehicle sign (a long light in a jam)', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(399), lastVehicleTs: at(100), hasEvidence: true, expected: null },
  { name: 'candidate: with evidence it ends 5 min after the last vehicle sign', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(400), lastVehicleTs: at(100), hasEvidence: true, expected: 'timeout' },
  { name: 'candidate: an auto candidate ends at its 30 min cap whatever it sees', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(1800), lastVehicleTs: at(1799), hasEvidence: true, expected: 'cap' },
  { name: 'candidate: at 29:59 with a vehicle in sight it runs on', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(1799), lastVehicleTs: at(1798), hasEvidence: true, expected: null },
  { name: 'candidate: a walk standing 20 s ends an auto candidate', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: at(40), now: at(60), lastVehicleTs: null, hasEvidence: false, expected: 'walking' },
  { name: 'candidate: a walk standing 19 s does not', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: at(41), now: at(60), lastVehicleTs: null, hasEvidence: false, expected: null },
  { name: 'candidate: a walk standing 5 s (the walk to the car) does not stop an auto candidate', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: at(55), now: at(60), lastVehicleTs: null, hasEvidence: false, expected: null },
  { name: 'candidate: a Start-card wait ends at its deadline', kind: 'candidate', trigger: 'manual', since: at(0), waitUntil: at(300), walkSince: null, now: at(300), lastVehicleTs: null, hasEvidence: false, expected: 'waitTimeout' },
  { name: 'candidate: a Start-card wait ignores walking and the 3 min', kind: 'candidate', trigger: 'manual', since: at(0), waitUntil: at(300), walkSince: at(0), now: at(299), lastVehicleTs: null, hasEvidence: false, expected: null },
  { name: 'starts after: a candidate that saw a vehicle leaves the hourly cap', kind: 'startsAfter', starts: [-3000, -500, 0].map(at), since: at(0), sawVehicle: true, expected: [-3000, -500].map(at) },
  { name: 'starts after: an empty candidate counts toward it', kind: 'startsAfter', starts: [-3000, -500, 0].map(at), since: at(0), sawVehicle: false, expected: [-3000, -500, 0].map(at) },

  // ——— the native safety stop ———
  {
    name: 'end: still, a JS end is overdue at 5 min after the last movement and native stops a minute later',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 0)), check(309), check(310), check(369), check(370)],
    expected: [none, { due: null, overdue: 'still' }, { due: null, overdue: 'still' }, { due: 'still', overdue: 'still' }],
  },
  {
    name: 'end: fix-less rows with car motion hold the still clock (a tunnel)',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 70, null), true), check(369), check(370), check(430)],
    expected: [none, { due: null, overdue: 'still' }, { due: 'still', overdue: 'still' }],
  },
  {
    name: 'end: fix-less rows without car motion do not hold',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 70, null)), check(310)],
    expected: [{ due: null, overdue: 'still' }],
  },
  {
    name: 'end: a walk standing 10 s with no fix over 3 mph is overdue; native stops 10 s later',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 0)), check(29, 20), check(30, 20), check(39, 20), check(40, 20)],
    expected: [none, { due: null, overdue: 'walking' }, { due: null, overdue: 'walking' }, { due: 'walking', overdue: 'walking' }],
  },
  {
    name: 'end: a JS end after the walking end (its report standing 3 s, less a row for the row clock) or the still end opens the linger',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 0)), check(21, 20), check(22, 20), check(30, 20), check(309), check(310)],
    expected: [
      { due: null, overdue: null, linger: false },
      { due: null, overdue: null, linger: true },
      { due: null, overdue: 'walking', linger: true },
      { due: null, overdue: null, linger: false },
      { due: null, overdue: 'still', linger: true },
    ],
  },
  {
    name: 'end: a walk standing 2 s after a 4 mph fix 2 s old (a carried phone): no walking end, but a JS end opens the linger',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 4)), check(21, 20), check(22, 20), check(22, 20, 300)],
    expected: [
      { due: null, overdue: null, linger: false },
      { due: null, overdue: null, linger: true },
      { due: null, overdue: null, linger: false },
    ],
  },
  {
    name: 'end: a walker\'s pace tops out at 5 mph: a 6 mph fix keeps the car driving and opens no linger',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 5)), check(25, 20), ...steps(vrows(21, 30, 6)), check(35, 30)],
    expected: [
      { due: null, overdue: null, linger: true },
      { due: null, overdue: null, linger: false },
    ],
  },
  {
    name: 'end: a walk with a fix over 3 mph in the last 15 s does not end the drive (parked where there is no sky)',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), check(25, 12), check(26, 12), check(31, 12), check(32, 12)],
    expected: [none, { due: null, overdue: 'walking' }, { due: null, overdue: 'walking' }, { due: 'walking', overdue: 'walking' }],
  },
  {
    name: 'end: a walk the car drives on from (a misread at a light) never ends the drive or opens the linger at the next stop; a walk after it does',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 15, 0)), ...steps(vrows(16, 25, 20)), ...steps(vrows(26, 45, 0)), check(45, 12), check(45, 35), check(55, 35)],
    expected: [
      { due: null, overdue: null, linger: false },
      { due: null, overdue: 'walking', linger: true },
      { due: 'walking', overdue: 'walking', linger: true },
    ],
  },
  {
    name: 'end: the walk to the car is void once the car drives: no walking end at the first stop',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 5, 0)), ...steps(vrows(6, 30, 15)), ...steps(vrows(31, 50, 0)), check(50, 1)],
    expected: [{ due: null, overdue: null, linger: false }],
  },
  {
    name: 'end: one row at driving speed after a walk is not driving: the walk stands',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 0)), ...steps(vrows(21, 21, 20)), ...steps(vrows(22, 41, 0)), check(41, 21)],
    expected: [{ due: 'walking', overdue: 'walking' }],
  },
  {
    name: 'end: two rows at driving speed, the second at the walk\'s arrival, void it; a walk arriving a second later stands',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 19, 0)), ...steps(vrows(20, 21, 20)), ...steps(vrows(22, 45, 0)), check(45, 21), check(45, 22)],
    expected: [none, { due: 'walking', overdue: 'walking' }],
  },
  {
    name: 'end: a JS end on a walk standing 3 s after a driving fix over 15 s old (no sky) opens the linger; one 14 s old does not',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), check(24, 21), check(28, 25)],
    expected: [
      { due: null, overdue: null, linger: false },
      { due: null, overdue: null, linger: true },
    ],
  },
  {
    name: 'end: moving again restarts the still clock',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 200, 0)), ...steps(vrows(201, 205, 20)), check(400), check(504), check(505)],
    expected: [none, none, { due: null, overdue: 'still' }],
  },
  {
    name: 'end: a trusted fix 100 m from where the car went still is movement',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 0)), { row: vrow(21, 2, { northM: 150 }), automotive: false }, check(320), check(321)],
    expected: [none, { due: null, overdue: 'still' }],
  },
  {
    name: 'end: a Start-card drive waiting for driving speed never ends on a walk (the walk to the car)',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 20, 0)), check(40, 10, 300), check(100, 10, 300), check(100, 10)],
    expected: [none, none, { due: 'walking', overdue: 'walking' }],
  },
  {
    name: 'end: a waiting Start-card drive ends on the still clock only once its wait is over too (a touch moves it on)',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 20, 0)), check(310, null, 400), check(400, null, 400), check(459, null, 400), check(460, null, 400), check(310, null, 100), check(360, null, 100)],
    expected: [none, { due: null, overdue: 'still' }, { due: null, overdue: 'still' }, { due: 'still', overdue: 'still' }, { due: null, overdue: 'still' }, { due: 'still', overdue: 'still' }],
  },
  {
    name: 'end: the 12 h cap comes before the other rules',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 5, 20)), check(43_200), check(43_260)],
    expected: [{ due: 'still', overdue: 'limit' }, { due: 'limit', overdue: 'limit' }],
  },

  // ——— "Not driving?" ———
  { name: 'suppress: ends at its 3 h cap', kind: 'suppress', since: at(0), until: at(10_800), lastOverStopTs: at(10_790), walkSince: null, now: at(10_800), expected: 'cap' },
  { name: 'suppress: ends on a walk standing 20 s', kind: 'suppress', since: at(0), until: at(10_800), lastOverStopTs: at(100), walkSince: at(100), now: at(120), expected: 'walking' },
  { name: 'suppress: a walk standing 19 s does not end it', kind: 'suppress', since: at(0), until: at(10_800), lastOverStopTs: at(100), walkSince: at(101), now: at(120), expected: null },
  { name: 'suppress: ends 5 min after anything over 3 mph', kind: 'suppress', since: at(0), until: at(10_800), lastOverStopTs: at(600), walkSince: null, now: at(900), expected: 'still' },
  { name: 'suppress: 5 min from its start with nothing over 3 mph', kind: 'suppress', since: at(0), until: at(10_800), lastOverStopTs: null, walkSince: null, now: at(300), expected: 'still' },
  { name: 'suppress: a bus still moving keeps it', kind: 'suppress', since: at(0), until: at(10_800), lastOverStopTs: at(800), walkSince: null, now: at(900), expected: null },
  {
    name: 'suppress resume: a relaunch 10 min into the rest keeps it; its still clock starts at the relaunch',
    kind: 'suppressResume',
    since: at(0),
    until: at(10_800),
    relaunch: at(600),
    checks: [at(605), at(899), at(900)],
    expected: { resumed: true, causes: [null, null, 'still'] },
  },
  {
    name: 'suppress resume: the 3 h cap is still measured from when the rest began',
    kind: 'suppressResume',
    since: at(0),
    until: at(10_800),
    relaunch: at(10_700),
    checks: [at(10_799), at(10_800)],
    expected: { resumed: true, causes: [null, 'cap'] },
  },
  { name: 'suppress resume: a relaunch at the cap ends the rest', kind: 'suppressResume', since: at(0), until: at(10_800), relaunch: at(10_800), checks: [], expected: { resumed: false, causes: [] } },

  // ——— a relaunch ———
  { name: 'resume: a last row 5 min old resumes', kind: 'resume', lastRowTs: at(0), startedAt: at(-600), now: at(300), expected: 'resume' },
  { name: 'resume: a last row older than 5 min is an orphan', kind: 'resume', lastRowTs: at(0), startedAt: at(-600), now: at(301), expected: 'orphan' },
  { name: 'resume: no rows yet, a start 2 min old resumes', kind: 'resume', lastRowTs: null, startedAt: at(0), now: at(120), expected: 'resume' },
  { name: 'resume seq: rows go on 1000 seqs past the journal’s highest, so none JS took in is reused', kind: 'resumeSeq', topSeq: 412, expected: 1412 },
  { name: 'resume seq: a drive with no rows yet', kind: 'resumeSeq', topSeq: 0, expected: 1000 },
  { name: 'resume seq: a second resume goes on past the first one’s reservation', kind: 'resumeSeq', topSeq: 1412, expected: 2412 },

  // ——— the status Settings and Home read ———
  { name: 'status: not armed is off', kind: 'status', inputs: statusIn({ armed: false, location: 'whenInUse' }), expected: { status: 'off', missing: [] } },
  { name: 'status: everything allowed is on', kind: 'status', inputs: statusIn(), expected: { status: 'on', missing: [] } },
  { name: 'status: While Using needs Always', kind: 'status', inputs: statusIn({ location: 'whenInUse' }), expected: { status: 'needs', missing: ['locationAlways'] } },
  {
    name: 'status: every need in order',
    kind: 'status',
    inputs: statusIn({ location: 'none', precise: false, motion: 'denied', backgroundRefresh: 'denied', liveActivities: false }),
    expected: { status: 'needs', missing: ['locationAlways', 'locationPrecise', 'motion', 'backgroundRefresh', 'liveActivities'] },
  },
  { name: 'status: Background App Refresh off is a need', kind: 'status', inputs: statusIn({ backgroundRefresh: 'restricted' }), expected: { status: 'needs', missing: ['backgroundRefresh'] } },
  { name: 'status: Live Activities off alone is not', kind: 'status', inputs: statusIn({ liveActivities: false }), expected: { status: 'on', missing: [] } },
  { name: 'status: a phone without the hardware is unavailable', kind: 'status', inputs: statusIn({ hardware: false }), expected: { status: 'unavailable', missing: [] } },
];
