/** @jest-environment node */
// The forgot-to-start reminder's policy against its decision table (src/reminder/vectors.ts), plus
// the properties no row may break: no gate opens while a drive is open or for a trip a drive was
// open in, and every post marks the trip reminded and starts the quiet.
import {
  appForeground,
  CALM_CTX,
  captureEnded,
  captureStarted,
  gate,
  INITIAL,
  newTrip,
  onFix,
  onStop,
  onTransitions,
  onWake,
  onWatchEnd,
  PAUSE_DAYS,
  posted,
  REMINDER,
  resolve,
  sessionEnded,
  setEnabled,
  settle,
  statusOf,
  summarizeActivities,
  tier,
  type FixVerdict,
  type GatePhase,
  type ReminderState,
} from '../src/reminder/policy';
import { REMINDER_VECTORS, T0, type ReminderVector } from '../src/reminder/vectors';

function run(v: ReminderVector): void {
  switch (v.kind) {
    case 'gate':
      expect(gate(v.state, v.ctx, v.now, v.phase)).toBe(v.expected);
      return;
    case 'ops': {
      let s = v.state;
      for (const o of v.ops) {
        if (o.op === 'settle') s = settle(s, o.now);
        else if (o.op === 'posted') s = posted(s, o.now);
        else if (o.op === 'resolve') s = resolve(s, o.outcome, o.now);
        else if (o.op === 'captureStarted') s = captureStarted(s, o.now);
        else if (o.op === 'captureEnded') s = captureEnded(s, o.now);
        else if (o.op === 'appForeground') s = appForeground(s);
        else if (o.op === 'setEnabled') s = setEnabled(s, o.on);
        else s = sessionEnded(s, o.now);
      }
      expect(s).toMatchObject(v.expected);
      return;
    }
    case 'transitions': {
      const r = onTransitions(v.state, v.events, v.arrival, v.subscribedAt, v.ctx);
      expect({ effect: r.effect, reason: r.reason }).toEqual({ effect: v.expected.effect, reason: v.expected.reason });
      if (v.expected.state) expect(r.state).toMatchObject(v.expected.state);
      return;
    }
    case 'wake': {
      const r = onWake(v.state, v.now, v.motion, v.ctx);
      expect({ effect: r.effect, reason: r.reason }).toEqual({ effect: v.expected.effect, reason: v.expected.reason });
      if (v.expected.trip === null) expect(r.state.trip).toBeNull();
      else if (v.expected.trip) expect(r.state.trip).toMatchObject(v.expected.trip);
      return;
    }
    case 'summary':
      expect(summarizeActivities(v.activities, v.now)).toEqual(v.expected);
      return;
    case 'fixes': {
      let tr = v.tracker;
      const verdicts: FixVerdict[] = [];
      for (const f of v.fixes) {
        const r = onFix(tr, f.fix, f.now);
        tr = r.tracker;
        verdicts.push(r.verdict);
      }
      expect(verdicts).toEqual(v.expected);
      return;
    }
    case 'stop': {
      const r = onStop(v.state, v.ctx, v.now, v.walked);
      expect({ effect: r.effect, reason: r.reason }).toEqual(v.expected);
      return;
    }
    case 'watchEnd': {
      const r = onWatchEnd(v.state, v.how, v.now);
      expect(r.effect).toBe(v.expected.effect);
      expect(r.state).toMatchObject(v.expected.state);
      return;
    }
  }
}

describe('the decision table', () => {
  test('has a row for every kind and unique names', () => {
    const kinds = new Set(REMINDER_VECTORS.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(['fixes', 'gate', 'ops', 'stop', 'summary', 'transitions', 'wake', 'watchEnd']);
    const names = REMINDER_VECTORS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(REMINDER_VECTORS.length).toBeGreaterThanOrEqual(60);
  });

  test.each(REMINDER_VECTORS.map((v) => [v.name, v] as const))('%s', (_name, v) => run(v));

  test('every gate reason is reached by some row', () => {
    const reached = new Set(REMINDER_VECTORS.filter((v) => v.kind === 'gate').map((v) => v.expected));
    for (const r of ['off', 'paused', 'quiet', 'permission', 'capturing', 'no-trip', 'recorded', 'reminded', 'after-drive', 'daily-cap', 'low-power', 'sessions', 'foreground', 'not-fresh', 'too-soon', 'in-call', 'stale', 'on-foot', 'ok']) {
      expect({ r, reached: reached.has(r as never) }).toEqual({ r, reached: true });
    }
  });
});

describe('properties', () => {
  const phases: GatePhase[] = ['wake', 'session', 'stop'];
  const states: ReminderState[] = REMINDER_VECTORS.flatMap((v) => ('state' in v ? [v.state] : []));

  test('no gate opens while a drive is open, or for a trip a drive was open in', () => {
    for (const s of states) {
      for (const phase of phases) {
        expect(gate(s, { ...CALM_CTX, capturing: true }, T0, phase)).not.toBe('ok');
        if (s.trip && phase !== 'wake') expect(gate({ ...s, trip: { ...s.trip, recorded: true } }, CALM_CTX, T0, phase)).not.toBe('ok');
      }
    }
  });

  test('a post always marks the trip reminded and starts the 4 h quiet', () => {
    for (const s of states.filter((x) => x.trip)) {
      const p = posted(s, T0);
      expect(p.trip?.reminded).toBe(true);
      expect(p.quietUntil).toBe(T0 + REMINDER.UNUSED_QUIET_MS);
      expect(p.showing).toBe(true);
    }
  });

  test('nothing mutates its input', () => {
    const s = setEnabled(INITIAL, true);
    const frozen = JSON.stringify(s);
    posted(s, T0);
    captureStarted(s, T0);
    settle({ ...s, trip: newTrip(T0 - 4 * 3_600_000) }, T0);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  test('the tier follows the capture, the switch and the trip', () => {
    const on = setEnabled(INITIAL, true);
    expect(tier(on, false, false)).toBe('none');
    expect(tier(INITIAL, true, true)).toBe('capture');
    expect(tier(INITIAL, false, true)).toBe('none');
    expect(tier(on, false, true)).toBe('idle');
    expect(tier({ ...on, trip: newTrip(T0) }, false, true)).toBe('trip');
    // paused or quiet still listens, so a pause can end without RoadWise being opened
    expect(tier({ ...on, pausedUntil: T0 + 1 }, false, true)).toBe('idle');
  });

  test('status: unavailable, off, needs, paused, on', () => {
    const on = setEnabled(INITIAL, true);
    expect(statusOf(on, T0, false, []).state).toBe('unavailable');
    expect(statusOf(INITIAL, T0, true, ['motion'])).toEqual({ enabled: false, state: 'off', autoOff: false, missing: [], pausedUntil: null });
    expect(statusOf(on, T0, true, ['notifications', 'motion']).missing).toEqual(['notifications', 'motion']);
    expect(statusOf({ ...on, pausedUntil: T0 + 5 }, T0, true, [])).toMatchObject({ state: 'paused', pausedUntil: T0 + 5 });
    expect(statusOf(on, T0, true, []).state).toBe('on');
  });

  test('the back-off is 7 days, then 28, then off', () => {
    expect([...PAUSE_DAYS]).toEqual([7, 28]);
    let s = setEnabled(INITIAL, true);
    for (let i = 0; i < 9; i += 1) s = resolve(s, 'missed', T0);
    expect(s).toMatchObject({ enabled: false, autoOff: true });
  });
});
