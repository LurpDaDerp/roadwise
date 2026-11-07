/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import {
  BREAK_AFTER_DROWSY_MS,
  BREAK_KEY,
  BREAK_REMINDER_MS,
  breakDecision,
  createBreakWatch,
  HOUR_MS,
  parseBreakMark,
  remindedHFor,
  writeBreakMark,
  type BreakInput,
  type BreakWatch,
} from '@/drive/breakWatch';
import { en } from '@/i18n/en';

const DROVE = 1_790_000_000_000;
const H = HOUR_MS;

/** A live row in front, the car moving, nothing busy. */
const at = (ts: number, over: Partial<BreakInput> = {}): BreakInput => ({
  ts,
  droveAt: DROVE,
  stopped: false,
  replay: false,
  foreground: true,
  waiting: false,
  busy: false,
  ending: false,
  drowsyAgoMs: null,
  ...over,
});

/** `n` stopped rows from `t0`, one a second; the reminders they gave. */
function stop(w: BreakWatch, t0: number, n = 2, over: Partial<BreakInput> = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = w.push(at(t0 + i * 1000, { stopped: true, ...over }));
    if (r !== null) out.push(r);
  }
  return out;
}

test('the numbers: 2 h first, then every hour; 2 stopped rows; 10 min after a DashPal drowsy alert; 4 s on screen', () => {
  expect(HOUR_MS).toBe(3_600_000);
  expect(BREAK_AFTER_DROWSY_MS).toBe(600_000);
  expect(BREAK_REMINDER_MS).toBe(4000);
  expect(BREAK_KEY).toBe('drive.breakReminder');
});

test('nothing before 2 h of driving, however long the stop', () => {
  const w = createBreakWatch();
  expect(stop(w, DROVE + 2 * H - 10_000, 9)).toEqual([]);
  expect(w.remindedH()).toBe(0);
});

test('past 2 h it fires on the second stopped row in a row, once; a moving row in between starts the count again', () => {
  const w = createBreakWatch();
  const t = DROVE + 2 * H + 60_000;
  expect(w.push(at(t))).toBeNull();
  expect(w.push(at(t + 1000, { stopped: true }))).toBeNull();
  expect(w.push(at(t + 2000))).toBeNull();
  expect(w.push(at(t + 3000, { stopped: true }))).toBeNull();
  expect(w.push(at(t + 4000, { stopped: true }))).toEqual({ key: `break@${t + 4000}`, at: t + 4000, hours: 2 });
  expect(stop(w, t + 5000, 30)).toEqual([]);
  expect(w.remindedH()).toBe(2);
});

test('then at 3 h and 4 h of driving (fixed hours from driving speed), each at its first stop', () => {
  const w = createBreakWatch();
  expect(stop(w, DROVE + 2 * H + 5 * 60_000).map((r) => r.hours)).toEqual([2]);
  // A stop before the 3 h mark gives nothing.
  expect(stop(w, DROVE + 3 * H - 60_000, 10)).toEqual([]);
  w.push(at(DROVE + 3 * H - 1000));
  expect(stop(w, DROVE + 3 * H + 10 * 60_000).map((r) => r.hours)).toEqual([3]);
  w.push(at(DROVE + 3 * H + 11 * 60_000));
  expect(stop(w, DROVE + 4 * H).map((r) => r.hours)).toEqual([4]);
});

test('behind it waits: a mark passed behind fires at the next stop in front; a stop counted behind carries into the front', () => {
  const w = createBreakWatch();
  expect(stop(w, DROVE + 2 * H + 1000, 20, { foreground: false })).toEqual([]);
  // Still stopped, now in front: the very next row.
  expect(w.push(at(DROVE + 2 * H + 30_000, { stopped: true }))).toMatchObject({ hours: 2 });
});

test('several marks passed at once make one reminder; the next is the first whole hour after it', () => {
  const w = createBreakWatch();
  stop(w, DROVE + 2 * H, 2, { foreground: false });
  const r = stop(w, DROVE + 4 * H + 20 * 60_000);
  expect(r.map((x) => x.hours)).toEqual([4]);
  w.push(at(DROVE + 4 * H + 30 * 60_000));
  expect(stop(w, DROVE + 5 * H - 5000, 4)).toEqual([]);
  w.push(at(DROVE + 5 * H));
  expect(stop(w, DROVE + 5 * H + 1000).map((x) => x.hours)).toEqual([5]);
});

test('busy (an alert showing, a DashPal continuous alert) defers it without using it up', () => {
  const w = createBreakWatch();
  const t = DROVE + 2 * H + 1000;
  expect(stop(w, t, 5, { busy: true })).toEqual([]);
  expect(w.push(at(t + 5000, { stopped: true }))).toMatchObject({ hours: 2 });
});

test('the place-arrival end pending (the drive about to end where it stopped) defers it without using it up', () => {
  const w = createBreakWatch();
  const t = DROVE + 2 * H + 1000;
  expect(stop(w, t, 5, { ending: true })).toEqual([]);
  expect(w.push(at(t + 5000, { stopped: true }))).toMatchObject({ hours: 2 });
});

test('a reminder handed back (dropped unplayed) comes again at the next stop; an older one handed back is ignored', () => {
  const w = createBreakWatch();
  const t = DROVE + 2 * H + 1000;
  const [first] = stop(w, t);
  expect(first).toMatchObject({ hours: 2 });
  expect(w.remindedH()).toBe(2);
  w.release(first!);
  expect(w.remindedH()).toBe(0);
  w.push(at(t + 60_000));
  const [again] = stop(w, t + 61_000);
  expect(again).toMatchObject({ hours: 2 });
  // Handing back the first (stale) one again changes nothing; the second still counts.
  w.release(first!);
  expect(w.remindedH()).toBe(2);
  // Several marks covered by one reminder: handed back, they all count again.
  const v = createBreakWatch({ remindedH: 2 });
  const [late] = stop(v, DROVE + 4 * H + 1000);
  expect(late).toMatchObject({ hours: 4 });
  v.release(late!);
  expect(v.remindedH()).toBe(2);
});

test('within 10 min after a DashPal drowsy alert it waits; from 10 min on it is given', () => {
  const w = createBreakWatch();
  const t = DROVE + 2 * H + 1000;
  expect(stop(w, t, 3, { drowsyAgoMs: BREAK_AFTER_DROWSY_MS - 1 })).toEqual([]);
  expect(w.push(at(t + 3000, { stopped: true, drowsyAgoMs: BREAK_AFTER_DROWSY_MS }))).toMatchObject({ hours: 2 });
  // A clock that reads the alert in the future (a negative age) never holds it back.
  const v = createBreakWatch();
  expect(stop(v, t, 2, { drowsyAgoMs: -5000 })).toHaveLength(1);
});

test('replayed rows neither fire nor count as a stop', () => {
  const w = createBreakWatch();
  const t = DROVE + 2 * H + 1000;
  expect(stop(w, t, 10, { replay: true })).toEqual([]);
  // One live stopped row after them is not yet two in a row.
  expect(w.push(at(t + 10_000, { stopped: true }))).toBeNull();
  expect(w.push(at(t + 11_000, { stopped: true }))).toMatchObject({ hours: 2 });
});

test('never while a Start-card drive waits, nor before the drive reached driving speed', () => {
  const w = createBreakWatch();
  expect(stop(w, DROVE + 3 * H, 5, { waiting: true })).toEqual([]);
  expect(stop(w, DROVE + 3 * H + 5000, 5, { droveAt: null })).toEqual([]);
  expect(stop(w, DROVE + 3 * H + 10_000)).toHaveLength(1);
});

test('a drive taken up again keeps its last reminded hour: no repeat, the next hour still comes', () => {
  const w = createBreakWatch({ remindedH: 2 });
  expect(stop(w, DROVE + 2 * H + 30 * 60_000, 5)).toEqual([]);
  w.push(at(DROVE + 3 * H));
  expect(stop(w, DROVE + 3 * H + 1000).map((r) => r.hours)).toEqual([3]);
  // A bad stored hour reads as none.
  expect(createBreakWatch({ remindedH: -1 }).remindedH()).toBe(0);
  expect(createBreakWatch({ remindedH: 1.5 }).remindedH()).toBe(0);
});

test('the decision: the soft tone, "Take a break soon" spoken even with voice off, one light pulse', () => {
  expect(breakDecision({ key: 'break@5', at: 5, hours: 3 }, 'trip-1')).toEqual({
    id: 'break:trip-1:3',
    level: 1,
    kind: 'break',
    ts: 5,
    voice: en['alert.takeABreak'],
    voiceAlways: true,
    intensity: 1,
  });
  expect(en['alert.takeABreak']).toBe('Take a break soon');
});

describe('the stored mark', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createSqlJsDb();
    await migrate(db);
  });

  test('read back by trip id; another drive’s mark, or anything malformed, reads as none', async () => {
    expect(await remindedHFor(db, 'a')).toBe(0);
    await writeBreakMark(db, { clientTripId: 'a', remindedH: 3 });
    expect(await remindedHFor(db, 'a')).toBe(3);
    expect(await remindedHFor(db, 'b')).toBe(0);
    for (const bad of [null, 3, 'x', {}, { clientTripId: '', remindedH: 2 }, { clientTripId: 'a', remindedH: -1 }, { clientTripId: 'a', remindedH: 2.5 }, { clientTripId: 'a', remindedH: '2' }]) {
      expect(parseBreakMark(bad)).toBeNull();
    }
    await createSettingsRepo(db).set(BREAK_KEY, { clientTripId: 'a', remindedH: 'two' });
    expect(await remindedHFor(db, 'a')).toBe(0);
  });
});
