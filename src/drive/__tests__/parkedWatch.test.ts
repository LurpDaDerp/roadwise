/** "Where you parked": the arming checks (the car stood still, the end point) and the walk-away watch. */
import type { MotionActivity } from '@drive-sense';

import { haversineMeters } from '@/lib/geo';

import {
  createParkedWatch,
  createRowTrail,
  PARKED_CALM_MS,
  PARKED_FIX_ACC_M,
  PARKED_GIVE_UP_MS,
  PARKED_PLACE_M,
  PARKED_STOPPED_MPS,
  PARKED_WALK_MS,
  PARKED_WALK_PACE_MPS,
  PARKED_WALK_START_MS,
  spotQualifies,
} from '../parkedWatch';

const T = 1_800_000_000_000;
const row = (ts: number, speed: number, over: Partial<{ hAcc: number; gnssValid: boolean; speedAcc: number }> = {}) => ({ ts, speed, hAcc: 5, gnssValid: true, speedAcc: 0.5, ...over });
const act = (type: MotionActivity['type'], ts: number, confidence: MotionActivity['confidence'] = 'high'): MotionActivity => ({ type, ts, confidence });

describe('the car stood still when it left the route', () => {
  test('the last trusted speed before at most 1 mph, nothing after over walking pace', () => {
    const trail = createRowTrail();
    [row(T - 3000, 10), row(T - 2000, 2), row(T - 1000, PARKED_STOPPED_MPS), row(T, 0), row(T + 1000, PARKED_WALK_PACE_MPS)].forEach((r) => trail.push(r));
    expect(trail.stoppedAt(T, T + 5000)).toBe(true);
  });

  test('moving as it left, or driving on after: no', () => {
    const moving = createRowTrail();
    [row(T - 2000, 0), row(T - 1000, PARKED_STOPPED_MPS + 0.05)].forEach((r) => moving.push(r));
    expect(moving.stoppedAt(T, T + 5000)).toBe(false);
    const after = createRowTrail();
    [row(T - 1000, 0), row(T + 3000, PARKED_WALK_PACE_MPS + 0.1)].forEach((r) => after.push(r));
    expect(after.stoppedAt(T, T + 5000)).toBe(false);
    // A fast row after the drive closed is not looked at.
    expect(after.stoppedAt(T, T + 2000)).toBe(true);
  });

  test("after the car's last movement (the cut) the phone may walk away before the car leaves the route", () => {
    const cut = T - 15_000;
    const trail = createRowTrail();
    [row(cut - 1000, 10), row(cut, 6), row(cut + 2000, 1), row(cut + 4000, 0), ...[6, 8, 10, 12, 14].map((d) => row(cut + d * 1000, 1.4))].forEach((r) => trail.push(r));
    // The last speed before T is a walk: not by the plain rule, but the car had stopped at its cut.
    expect(trail.stoppedAt(T, T - 1000)).toBe(false);
    expect(trail.stoppedAt(T, T - 1000, cut)).toBe(true);
    expect(trail.stoppedAt(T + 20_000, T - 1000, cut)).toBe(true);
    // The car left before its last movement: the plain rule alone.
    expect(trail.stoppedAt(cut - 500, T - 1000, cut)).toBe(false);
  });

  test('after the cut: never standing still, faster than walking, or a trail that starts after it: no', () => {
    const cut = T - 15_000;
    const rolling = createRowTrail();
    [row(cut - 1000, 10), row(cut, 6), ...[2, 4, 6, 8].map((d) => row(cut + d * 1000, 1.4))].forEach((r) => rolling.push(r));
    expect(rolling.stoppedAt(T, T - 1000, cut)).toBe(false);
    const fast = createRowTrail();
    [row(cut, 6), row(cut + 2000, 0), row(cut + 6000, PARKED_WALK_PACE_MPS + 0.2), row(cut + 8000, 1.4)].forEach((r) => fast.push(r));
    expect(fast.stoppedAt(T, T - 1000, cut)).toBe(false);
    const short = createRowTrail();
    [row(cut + 2000, 0), row(cut + 6000, 1.4)].forEach((r) => short.push(r));
    expect(short.stoppedAt(T, T - 1000, cut)).toBe(false);
  });

  test('untrusted or unknown speeds are skipped; nothing known before it left, or a trail that starts after: no', () => {
    const trail = createRowTrail();
    [row(T - 3000, 0), row(T - 2000, 8, { speedAcc: 5 }), row(T - 1000, -1), row(T + 1000, 9, { gnssValid: false })].forEach((r) => trail.push(r));
    expect(trail.stoppedAt(T, T + 5000)).toBe(true);
    const unknown = createRowTrail();
    [row(T - 2000, -1), row(T - 1000, 3, { speedAcc: 9 })].forEach((r) => unknown.push(r));
    expect(unknown.stoppedAt(T, T + 5000)).toBe(false);
    const late = createRowTrail();
    late.push(row(T, 0));
    expect(late.stoppedAt(T, T + 5000)).toBe(false);
    expect(createRowTrail().stoppedAt(T, T)).toBe(false);
  });

  test('the trail keeps its newest rows only, and resets', () => {
    const trail = createRowTrail(3);
    [0, 1, 2, 3].forEach((i) => trail.push(row(T + i * 1000, 0)));
    expect(trail.accuracyAt(T)).toBeNull();
    expect(trail.accuracyAt(T + 3000)).toBe(5);
    trail.reset();
    expect(trail.accuracyAt(T + 3000)).toBeNull();
  });
});

describe('the end point', () => {
  const home = { lat: 47.6062, lng: -122.3321 };
  const north = (m: number) => ({ lat: home.lat + m / 111_195, lng: home.lng });

  test('fixed to 20 m or better, and more than 150 m from every saved place', () => {
    expect(haversineMeters(home, north(151))).toBeGreaterThan(PARKED_PLACE_M);
    expect(spotQualifies(north(151), PARKED_FIX_ACC_M, [home])).toBe(true);
    expect(spotQualifies(north(149), 5, [home])).toBe(false);
    expect(spotQualifies(north(500), PARKED_FIX_ACC_M + 0.1, [home])).toBe(false);
    expect(spotQualifies(north(500), null, [])).toBe(false);
    expect(spotQualifies(north(500), 5, [])).toBe(true);
  });

  test('accuracy is the valid fix at that time', () => {
    const trail = createRowTrail();
    trail.push(row(T, 0, { hAcc: 12 }));
    trail.push(row(T + 1000, 0, { hAcc: 30, gnssValid: false }));
    expect(trail.accuracyAt(T)).toBe(12);
    expect(trail.accuracyAt(T + 1000)).toBeNull();
    expect(trail.accuracyAt(T + 500)).toBeNull();
  });
});

describe('the walk away', () => {
  test('confirmed once a walk held 15 s and it is 60 s after it began', () => {
    const w = createParkedWatch(T);
    expect(w.activity(act('walking', T + 10_000), T + 10_000)).toBe('watching');
    expect(w.dueAt()).toBe(T + 10_000 + PARKED_WALK_MS);
    expect(w.tick(T + 10_000 + PARKED_WALK_MS)).toBe('watching');
    expect(w.dueAt()).toBe(T + 10_000 + PARKED_CALM_MS);
    expect(w.tick(T + 10_000 + PARKED_CALM_MS - 1)).toBe('watching');
    expect(w.tick(T + 10_000 + PARKED_CALM_MS)).toBe('confirmed');
    expect(w.dueAt()).toBeNull();
  });

  test('standing still after the walk held does not undo it (indoors at the door)', () => {
    const w = createParkedWatch(T);
    w.activity(act('running', T + 1000), T + 1000);
    w.tick(T + 20_000);
    w.activity(act('stationary', T + 30_000), T + 30_000);
    expect(w.tick(T + 1000 + PARKED_CALM_MS)).toBe('confirmed');
  });

  test('standing still before the walk held breaks it; a later walk starts again', () => {
    const w = createParkedWatch(T);
    w.activity(act('walking', T + 1000), T + 1000);
    w.activity(act('stationary', T + 10_000), T + 10_000);
    expect(w.tick(T + 1000 + PARKED_CALM_MS)).toBe('watching');
    w.activity(act('walking', T + 70_000), T + 70_000);
    expect(w.tick(T + 70_000 + PARKED_CALM_MS - 1)).toBe('watching');
    expect(w.tick(T + 70_000 + PARKED_CALM_MS)).toBe('confirmed');
  });

  test('car motion from the car leaving on drops it, even after the walk held', () => {
    for (const type of ['automotive', 'cycling'] as const) {
      const w = createParkedWatch(T);
      w.activity(act('walking', T + 1000), T + 1000);
      w.tick(T + 30_000);
      expect(w.activity(act(type, T + 40_000, 'medium'), T + 40_000)).toBe('dropped');
      expect(w.tick(T + PARKED_CALM_MS * 2)).toBe('dropped');
    }
  });

  test('low-confidence reports, unknown ones and Android exits change nothing', () => {
    const w = createParkedWatch(T);
    w.activity(act('automotive', T + 1000, 'low'), T + 1000);
    w.activity(act('walking', T + 2000, 'low'), T + 2000);
    w.activity({ ...act('walking', T + 2500), exit: true }, T + 2500);
    expect(w.dueAt()).toBe(T + PARKED_GIVE_UP_MS);
    w.activity(act('walking', T + 3000), T + 3000);
    w.activity(act('unknown', T + 5000), T + 5000);
    w.activity(act('stationary', T + 6000, 'low'), T + 6000);
    expect(w.tick(T + 3000 + PARKED_CALM_MS)).toBe('confirmed');
  });

  test('a walk must begin within 3 min of the car leaving; none confirmed by 4 min: dropped', () => {
    const late = createParkedWatch(T);
    late.activity(act('walking', T + PARKED_WALK_START_MS + 1), T + PARKED_WALK_START_MS + 1);
    expect(late.tick(T + PARKED_GIVE_UP_MS - 1)).toBe('watching');
    expect(late.tick(T + PARKED_GIVE_UP_MS)).toBe('dropped');
    // At the 3-minute line it counts, and confirms on the 4-minute line.
    const edge = createParkedWatch(T);
    edge.activity(act('walking', T + PARKED_WALK_START_MS), T + PARKED_WALK_START_MS);
    expect(edge.dueAt()).toBe(T + PARKED_WALK_START_MS + PARKED_WALK_MS);
    edge.tick(T + PARKED_WALK_START_MS + PARKED_WALK_MS);
    expect(edge.tick(T + PARKED_GIVE_UP_MS)).toBe('confirmed');
    const none = createParkedWatch(T);
    expect(none.tick(T + PARKED_GIVE_UP_MS)).toBe('dropped');
  });

  test('a new drive drops it', () => {
    const w = createParkedWatch(T);
    w.activity(act('walking', T + 1000), T + 1000);
    expect(w.driveStarted()).toBe('dropped');
    expect(w.outcome()).toBe('dropped');
  });

  test('a walk standing as the car left counts from then; a later stationary breaks it, and an old report heard late changes nothing', () => {
    // The walking end: the drive ended 10 s into a walk, then the car's Bluetooth went.
    const w = createParkedWatch(T);
    w.activity(act('automotive', T - 60_000), T - 60_000);
    w.activity(act('walking', T - 12_000), T);
    expect(w.dueAt()).toBe(T + PARKED_WALK_MS);
    expect(w.tick(T + PARKED_CALM_MS)).toBe('confirmed');
    // Driving before the car left is no drop.
    const d = createParkedWatch(T);
    expect(d.activity(act('automotive', T - 5000), T)).toBe('watching');
    // A walk before, then standing still before the car left: no walk under way.
    const s = createParkedWatch(T);
    s.activity(act('walking', T - 20_000), T);
    s.activity(act('stationary', T - 10_000), T);
    expect(s.dueAt()).toBe(T + PARKED_GIVE_UP_MS);
    // A sure report from T on, then an older one heard late: the older one is ignored.
    const l = createParkedWatch(T);
    l.activity(act('walking', T + 2000), T + 2000);
    l.activity(act('stationary', T - 1000), T + 3000);
    expect(l.tick(T + 2000 + PARKED_CALM_MS)).toBe('confirmed');
  });
});
