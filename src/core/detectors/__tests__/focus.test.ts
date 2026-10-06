// Eyes off road and drowsiness from the camera's samples (spec event table, "Rules against false positives").
import { DMS_MIN_CONFIDENCE, DROWSY_S, EYES_OFF_MIN_MPH, EYES_OFF_S, NO_EVENTS_FIRST_S } from '@scoring';

import type { DmsFocusSample } from '@/core/dms';
import { createFocusDetector, DROWSY_COOLDOWN_S, TURN_RATE_DEG_S, TURN_TOTAL_DEG, WIDE_TURN_MAX_MPH } from '@/core/detectors/focus';
import type { Detector, FeatureRow } from '@/core/engine/types';

import { counterIds, ctx, limit, mph, only, row, T0 } from '../__fixtures__/rows';

const L = limit(mph(35));

/** A detector over a queue the test fills; `rows` drives it at 1 Hz. */
function make() {
  let queue: DmsFocusSample[] = [];
  const det: Detector = createFocusDetector(counterIds(), () => {
    const out = queue;
    queue = [];
    return out;
  });
  return {
    det,
    give: (...s: DmsFocusSample[]) => void queue.push(...s),
    /** push rows `from`..`to` (inclusive indices) with `over`, collecting every event */
    run(from: number, to: number, over: Partial<FeatureRow> | ((i: number) => Partial<FeatureRow>) = {}, c = ctx()) {
      const all = [];
      for (let i = from; i <= to; i++) all.push(...det.push(row(typeof over === 'function' ? over(i) : over, i), L, c));
      return all;
    },
  };
}

const glance = (glanceS: number, endRow: number, over: Partial<DmsFocusSample> = {}): DmsFocusSample => ({ kind: 'glance', glanceS, q: 0.95, endT: T0 + endRow * 1000, wideTurn: false, lowLight: false, ...over });
const sign = (s: number, endRow: number, over: Partial<DmsFocusSample> = {}): DmsFocusSample => ({ kind: 'drowsiness', glanceS: s, q: 1, endT: T0 + endRow * 1000, wideTurn: false, lowLight: false, ...over });

describe('eyes_off', () => {
  test('a 2.5 s glance at 33 mph ends on row 10: a minor eyes_off that started 2.5 s earlier, at the slowest speed of the glance', () => {
    const h = make();
    h.run(0, 9, { speed: mph(33) });
    h.give(glance(2.5, 10));
    const e = only(h.run(10, 10, { speed: mph(33) }));
    expect(e).toEqual({ id: 'e1', type: 'eyes_off', tier: 'minor', startedAt: T0 + 10_000 - 2500, durationS: 2.5, measured: { speedMph: 33 } });
  });
  test(`the thresholds: ≥ ${EYES_OFF_S.minor} s minor, ≥ ${EYES_OFF_S.severe} s severe, shorter nothing`, () => {
    const h = make();
    h.run(0, 9, { speed: mph(40) });
    h.give(glance(1.9, 10), glance(2.0, 10), glance(3.9, 10), glance(4.0, 10));
    expect(h.run(10, 10, { speed: mph(40) }).map((e) => [e.durationS, e.tier])).toEqual([
      [2, 'minor'],
      [3.9, 'minor'],
      [4, 'severe'],
    ]);
  });
  test(`the speed: below ${EYES_OFF_MIN_MPH} mph nothing; exactly at it counts; a dip under it anywhere in the glance drops it; unknown speed drops it`, () => {
    const slow = make();
    slow.run(0, 9, { speed: mph(9.9) });
    slow.give(glance(3, 10));
    expect(slow.run(10, 10, { speed: mph(9.9) })).toEqual([]);

    const edge = make();
    edge.run(0, 9, { speed: mph(EYES_OFF_MIN_MPH) });
    edge.give(glance(3, 10));
    expect(edge.run(10, 10, { speed: mph(EYES_OFF_MIN_MPH) })).toHaveLength(1);

    const dip = make();
    dip.run(0, 9, (i) => ({ speed: i === 8 ? mph(6) : mph(30) }));
    dip.give(glance(3, 10)); // covers rows 7–10
    expect(dip.run(10, 10, { speed: mph(30) })).toEqual([]);

    const unknown = make();
    unknown.run(0, 9, { gnssValid: false, speed: -1 });
    unknown.give(glance(3, 10));
    expect(unknown.run(10, 10, { gnssValid: false, speed: -1 })).toEqual([]);
  });
  test(`a wide head turn (far lateral) below ${WIDE_TURN_MAX_MPH} mph is not eyes off; at speed it is`, () => {
    const lot = make();
    lot.run(0, 9, { speed: mph(12) });
    lot.give(glance(3, 10, { wideTurn: true }), glance(3, 10, { wideTurn: false }));
    expect(lot.run(10, 10, { speed: mph(12) }).map((e) => e.measured.speedMph)).toEqual([12]);

    const fast = make();
    fast.run(0, 9, { speed: mph(20) });
    fast.give(glance(3, 10, { wideTurn: true }));
    expect(fast.run(10, 10, { speed: mph(20) })).toHaveLength(1);
  });
  test(`a turn during the glance (course rate ≥ ${TURN_RATE_DEG_S}°/s, or ≥ ${TURN_TOTAL_DEG}° in all) suppresses it; a straight road does not`, () => {
    const junction = make();
    junction.run(0, 9, (i) => ({ speed: mph(20), course: i >= 8 ? 90 + (i - 7) * 10 : 90 })); // 10°/s from row 8
    junction.give(glance(3, 10));
    expect(junction.run(10, 10, { speed: mph(20), course: 120 })).toEqual([]);

    const bend = make();
    bend.run(0, 9, (i) => ({ speed: mph(30), course: 90 + Math.max(0, i - 5) * 6 })); // 6°/s: under the rate, 30° over the glance
    bend.give(glance(4, 10)); // rows 6–10: 90+6 → 90+30 = 24° … plus row 10 at 120 → ≥ 25° in all
    expect(bend.run(10, 10, { speed: mph(30), course: 120 })).toEqual([]);

    const straight = make();
    straight.run(0, 9, (i) => ({ speed: mph(30), course: 90 + (i % 2) * 3 })); // GNSS jitter of 3°
    straight.give(glance(3, 10));
    expect(straight.run(10, 10, { speed: mph(30), course: 90 })).toHaveLength(1);
  });
  test(`the confidence gate: q below ${DMS_MIN_CONFIDENCE} is dropped; exactly at it counts`, () => {
    const h = make();
    h.run(0, 9, { speed: mph(30) });
    h.give(glance(3, 10, { q: 0.84 }), glance(3, 10, { q: DMS_MIN_CONFIDENCE }));
    expect(h.run(10, 10, { speed: mph(30) })).toHaveLength(1);
  });
  test(`no events in the first ${NO_EVENTS_FIRST_S} s of a drive, and none on a poor fix`, () => {
    const young = make();
    const c = ctx({ tripStartedAt: T0 + 10_000 - (NO_EVENTS_FIRST_S - 1) * 1000 });
    young.run(0, 9, { speed: mph(30) }, c);
    young.give(glance(3, 10));
    expect(young.run(10, 10, { speed: mph(30) }, c)).toEqual([]);

    const poor = make();
    poor.run(0, 9, { speed: mph(30) });
    poor.give(glance(3, 10));
    expect(poor.run(10, 10, { speed: mph(30), hAcc: 25 })).toEqual([]);
  });
  test('a glance that started before the drive is clipped to the drive start', () => {
    const h = make();
    const c = ctx({ tripStartedAt: T0 + 10_000 - (NO_EVENTS_FIRST_S + 1) * 1000 });
    h.run(0, 9, { speed: mph(30) }, c);
    h.give(glance(2.5, 10));
    expect(only(h.run(10, 10, { speed: mph(30) }, c)).startedAt).toBe(T0 + 7500);
  });
  test('no sample, no event; flush judges the samples closed with the drive on the last row', () => {
    const h = make();
    expect(h.run(0, 9, { speed: mph(30) })).toEqual([]);
    h.give(glance(3, 9));
    expect(h.det.flush()).toHaveLength(1);
    expect(h.det.flush()).toEqual([]);
  });
});

describe('drowsy', () => {
  test(`one drowsy fatigue minute (${DROWSY_S} s of signs) is a severe drowsy event; shorter signs add up within the window`, () => {
    const minute = make();
    minute.run(0, 9, { speed: mph(45) });
    minute.give(sign(60, 10));
    expect(only(minute.run(10, 10, { speed: mph(45) }))).toEqual({ id: 'e1', type: 'drowsy', tier: 'severe', startedAt: T0 + 10_000 - 60_000, durationS: 60, measured: { speedMph: 45 } });

    const adding = make();
    adding.run(0, 9, { speed: mph(45) });
    adding.give(sign(20, 10));
    expect(adding.run(10, 10, { speed: mph(45) })).toEqual([]);
    adding.give(sign(20, 40));
    expect(adding.run(11, 40, { speed: mph(45) })).toEqual([]);
    adding.give(sign(20, 70));
    const e = only(adding.run(41, 70, { speed: mph(45) }));
    expect(e).toMatchObject({ type: 'drowsy', tier: 'severe', durationS: 60 });
    expect(e.startedAt).toBe(T0 + 10_000 - 20_000); // the first sign's start
  });
  test('signs older than the window fall out: 40 s now and 40 s three minutes ago never add up', () => {
    const h = make();
    h.run(0, 9, { speed: mph(45) });
    h.give(sign(40, 10));
    h.run(10, 189, { speed: mph(45) });
    h.give(sign(40, 190));
    expect(h.run(190, 190, { speed: mph(45) })).toEqual([]);
  });
  test('a sign taken in low light is ignored (no IR on phone cameras); so is one below the confidence gate', () => {
    const h = make();
    h.run(0, 9, { speed: mph(45) });
    h.give(sign(60, 10, { lowLight: true }), sign(60, 10, { q: 0.5 }));
    expect(h.run(10, 10, { speed: mph(45) })).toEqual([]);
  });
  test(`at most one drowsy event per ${DROWSY_COOLDOWN_S} s; signs keep adding up and the next one comes after the cooldown`, () => {
    const h = make();
    h.run(0, 9, { speed: mph(45) });
    h.give(sign(60, 10));
    expect(h.run(10, 10, { speed: mph(45) })).toHaveLength(1);
    h.run(11, 99, { speed: mph(45) });
    h.give(sign(60, 100));
    expect(h.run(100, 100, { speed: mph(45) })).toEqual([]); // 90 s after the first: still in the cooldown
    const at = 10 + DROWSY_COOLDOWN_S;
    h.run(101, at - 1, { speed: mph(45) });
    h.give(sign(60, at));
    expect(h.run(at, at, { speed: mph(45) })).toHaveLength(1);
  });
  test('drowsiness has no speed floor but keeps the first-30-s and poor-GPS rules', () => {
    const stopped = make();
    stopped.run(0, 9, { speed: 0 });
    stopped.give(sign(60, 10));
    expect(only(stopped.run(10, 10, { speed: 0 }))).toMatchObject({ type: 'drowsy', measured: { speedMph: 0 } });

    const young = make();
    const c = ctx({ tripStartedAt: T0 });
    young.run(0, 9, { speed: mph(30) }, c);
    young.give(sign(60, 10));
    expect(young.run(10, 10, { speed: mph(30) }, c)).toEqual([]);
  });
});
