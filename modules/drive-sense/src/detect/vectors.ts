// The drive detector's decision table (plan §3.3). Jest runs every row through the TypeScript
// reference (`policy.ts`, `__tests__/detectPolicy.test.ts`); the phone runs the same rows through
// the Swift policy (`DetectSelfTest.swift`) and the diagnostics screen diffs the answers
// (`selfTest.ts`). Each row names the rule it pins.
import {
  DETECT,
  MPS_PER_MPH,
  type ActivitySample,
  type DetectLastEnd,
  type DetectMissing,
  type DetectRow,
  type DetectStatus,
  type MotionGate,
  type MotionSummary,
  type SafetyCause,
  type StartSource,
  type StatusInputs,
  type TriggerKind,
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

export type DetectVector =
  | { name: string; kind: 'confirm'; trigger: TriggerKind; rows: DetectRow[]; veto: boolean[]; expected: { confirmedAt: number | null; runStartTs: number | null } }
  | { name: string; kind: 'trace'; rows: DetectRow[]; h: number; expected: { index: number | null } }
  | {
      name: string;
      kind: 'start';
      trigger: TriggerKind;
      rows: DetectRow[];
      automotiveSince: number;
      lastEnd: DetectLastEnd | null;
      expected: { confirmedAt: number | null; start: ExpectedStart | null };
    }
  | { name: string; kind: 'summary'; activities: ActivitySample[]; now: number; expected: MotionSummary }
  | { name: string; kind: 'motionGate'; summary: MotionSummary; now: number; expected: MotionGate }
  | { name: string; kind: 'wake'; ctx: WakeCtx; expected: WakeGate }
  | {
      name: string;
      kind: 'candidate';
      trigger: TriggerKind;
      since: number;
      waitUntil: number | null;
      walkSince: number | null;
      now: number;
      expected: 'timeout' | 'walking' | 'waitTimeout' | null;
    }
  | { name: string; kind: 'end'; startedAt: number; steps: EndStep[]; expected: { due: SafetyCause | null; overdue: SafetyCause | null }[] }
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

const no = (n: number) => Array.from({ length: n }, () => false);

const confirmRows = (rows: DetectRow[], veto?: (sec: number) => boolean) => ({ rows, veto: veto ? rows.map((r) => veto((r.ts - T0) / 1000)) : no(rows.length) });

const kerb = [...vrows(0, 60, 0), vrow(61, 5), vrow(62, 8), vrow(63, 12), vrow(64, 14), ...vrows(65, 100, 20)];

const act = (start: number, o: Partial<ActivitySample>): ActivitySample => ({ start, automotive: false, stationary: false, onFoot: false, confident: true, ...o });

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

export const DETECT_VECTORS: readonly DetectVector[] = [
  // ——— confirmation ———
  { name: 'auto: 20 mph held 30 s confirms on the row 30 s after the run began', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 20)), expected: { confirmedAt: at(30), runStartTs: at(0) } },
  { name: 'auto: 29 s at 20 mph then a stop never confirms', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 29, 20), ...vrows(30, 60, 0)]), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: 14 mph never confirms', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 14)), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: a dip under the trigger spanning 5 s keeps the hold', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 10, 20), ...vrows(11, 16, 10), ...vrows(17, 40, 20)]), expected: { confirmedAt: at(30), runStartTs: at(0) } },
  { name: 'auto: a dip spanning 6 s breaks the hold; the next run starts after it', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 10, 20), ...vrows(11, 17, 10), ...vrows(18, 60, 20)]), expected: { confirmedAt: at(48), runStartTs: at(18) } },
  { name: 'auto: rows with a 50 m fix are a dip', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 10, 20), ...vrows(11, 13, 20, { hAcc: 50 }), ...vrows(14, 40, 20)]), expected: { confirmedAt: at(30), runStartTs: at(0) } },
  { name: 'auto: rows with no fix are a dip', kind: 'confirm', trigger: 'auto', ...confirmRows([...vrows(0, 10, 20), ...vrows(11, 14, null), ...vrows(15, 40, 20)]), expected: { confirmedAt: at(30), runStartTs: at(0) } },
  { name: 'auto: a speed rated worse than 2 m/s never counts', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 60, 20, { speedAcc: 3 })), expected: { confirmedAt: null, runStartTs: null } },
  { name: 'auto: an unrated speed counts', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 20, { speedAcc: -1 })), expected: { confirmedAt: at(30), runStartTs: at(0) } },
  { name: 'auto: a fresh cycling report holds the confirmation to the next row', kind: 'confirm', trigger: 'auto', ...confirmRows(vrows(0, 40, 20), (s) => s === 30 || s === 31), expected: { confirmedAt: at(32), runStartTs: at(0) } },
  { name: 'manual: 10 mph held 15 s confirms', kind: 'confirm', trigger: 'manual', ...confirmRows(vrows(0, 20, 12)), expected: { confirmedAt: at(15), runStartTs: at(0) } },
  { name: 'manual: 8 mph never confirms', kind: 'confirm', trigger: 'manual', ...confirmRows(vrows(0, 40, 8)), expected: { confirmedAt: null, runStartTs: null } },

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

  // ——— the start (confirmation, trace-back, fallbacks, the merge hint) ———
  {
    name: 'start: a kerb departure starts at the kerb, placed there',
    kind: 'start',
    trigger: 'auto',
    rows: kerb,
    automotiveSince: 0,
    lastEnd: null,
    expected: { confirmedAt: at(95), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: rows that begin moving start at the car motion, at the parked spot it could have come from',
    kind: 'start',
    trigger: 'auto',
    rows: vrows(0, 40, 20, (s) => ({ northM: 500 + 9 * s })),
    automotiveSince: at(-60),
    lastEnd: lastEndAt(-600, 0),
    expected: { confirmedAt: at(30), start: { index: 0, startedAt: at(-60), startSource: 'motion', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: the motion start is not placed at a parked spot it could not have come from',
    kind: 'start',
    trigger: 'auto',
    rows: vrows(0, 40, 20, (s) => ({ northM: 500 + 9 * s })),
    automotiveSince: at(-60),
    lastEnd: lastEndAt(-600, -5000),
    expected: { confirmedAt: at(30), start: { index: 0, startedAt: at(-60), startSource: 'motion', startLat: null, startLng: null, continues: false } },
  },
  {
    name: 'start: without car motion before it, the first row starts the drive',
    kind: 'start',
    trigger: 'auto',
    rows: vrows(0, 40, 20, (s) => ({ northM: 9 * s })),
    automotiveSince: 0,
    lastEnd: null,
    expected: { confirmedAt: at(30), start: { index: 0, startedAt: at(0), startSource: 'wake', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: a Start-card drive never uses the motion start',
    kind: 'start',
    trigger: 'manual',
    rows: vrows(0, 20, 12),
    automotiveSince: at(-60),
    lastEnd: null,
    expected: { confirmedAt: at(15), start: { index: 0, startedAt: at(0), startSource: 'wake', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: a start 60 s after the last end and 50 m from it continues it',
    kind: 'start',
    trigger: 'auto',
    rows: kerb,
    automotiveSince: 0,
    lastEnd: lastEndAt(0, -50),
    expected: { confirmedAt: at(95), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: true } },
  },
  {
    name: 'start: 6 min after the last end is a new drive',
    kind: 'start',
    trigger: 'auto',
    rows: kerb,
    automotiveSince: 0,
    lastEnd: lastEndAt(-300, -50),
    expected: { confirmedAt: at(95), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  {
    name: 'start: 200 m from the last end is a new drive',
    kind: 'start',
    trigger: 'auto',
    rows: kerb,
    automotiveSince: 0,
    lastEnd: lastEndAt(0, -200),
    expected: { confirmedAt: at(95), start: { index: 60, startedAt: at(60), startSource: 'trace', startLat: north(0), startLng: LNG, continues: false } },
  },
  { name: 'start: no confirmation, no start', kind: 'start', trigger: 'auto', rows: vrows(0, 60, 12), automotiveSince: 0, lastEnd: null, expected: { confirmedAt: null, start: null } },

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
  { name: 'wake: armed, owned, allowed and idle passes', kind: 'wake', ctx: wakeCtx(), expected: 'ok' },
  { name: 'wake: not armed', kind: 'wake', ctx: wakeCtx({ armed: false }), expected: 'off' },
  { name: 'wake: no owner', kind: 'wake', ctx: wakeCtx({ hasOwner: false }), expected: 'noOwner' },
  { name: 'wake: a permission is missing', kind: 'wake', ctx: wakeCtx({ permissionsOk: false }), expected: 'permission' },
  { name: 'wake: a drive is recording', kind: 'wake', ctx: wakeCtx({ phase: 'recording' }), expected: 'busy' },
  { name: 'wake: suppressed after "Not driving?"', kind: 'wake', ctx: wakeCtx({ phase: 'suppressed' }), expected: 'busy' },
  { name: 'wake: a significant change rests after a timed-out candidate', kind: 'wake', ctx: wakeCtx({ candidateRestUntil: at(60) }), expected: 'resting' },
  { name: 'wake: a region exit ignores the rest', kind: 'wake', ctx: wakeCtx({ reason: 'region', candidateRestUntil: at(60) }), expected: 'ok' },
  { name: 'wake: six candidates in the hour is the cap', kind: 'wake', ctx: wakeCtx({ reason: 'region', candidateStarts: [-3000, -2500, -2000, -1500, -1000, -500].map(at) }), expected: 'capped' },
  { name: 'wake: candidates older than an hour do not count', kind: 'wake', ctx: wakeCtx({ candidateStarts: [-7200, -3600, -2000, -1500, -1000, -500].map(at) }), expected: 'ok' },

  // ——— a candidate's clock ———
  { name: 'candidate: an auto candidate ends at 3 min', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(180), expected: 'timeout' },
  { name: 'candidate: an auto candidate runs at 2:59', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: null, now: at(179), expected: null },
  { name: 'candidate: a walk standing 20 s ends an auto candidate', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: at(40), now: at(60), expected: 'walking' },
  { name: 'candidate: a walk standing 19 s does not', kind: 'candidate', trigger: 'auto', since: at(0), waitUntil: null, walkSince: at(41), now: at(60), expected: null },
  { name: 'candidate: a Start-card wait ends at its deadline', kind: 'candidate', trigger: 'manual', since: at(0), waitUntil: at(300), walkSince: null, now: at(300), expected: 'waitTimeout' },
  { name: 'candidate: a Start-card wait ignores walking and the 3 min', kind: 'candidate', trigger: 'manual', since: at(0), waitUntil: at(300), walkSince: at(0), now: at(299), expected: null },

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
    name: 'end: a walk standing 20 s with no fix over 3 mph is overdue; native stops 60 s later',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), ...steps(vrows(11, 20, 0)), check(39, 20), check(40, 20), check(99, 20), check(100, 20)],
    expected: [none, { due: null, overdue: 'walking' }, { due: null, overdue: 'walking' }, { due: 'walking', overdue: 'walking' }],
  },
  {
    name: 'end: a walk with a fix over 3 mph in the last minute does not end the drive',
    kind: 'end',
    startedAt: at(0),
    steps: [...steps(vrows(0, 10, 20)), check(40, 20), check(70, 20), check(71, 20)],
    expected: [none, none, { due: null, overdue: 'walking' }],
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
