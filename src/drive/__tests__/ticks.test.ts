import { CONSTANTS } from '@scoring';

import { createTicker, TICK_RETRY_MS, TICK_SLACK_MS, tickDeadline, type Scheduler } from '@/drive/ticks';

const T = 1_700_000_000_000;

function manual() {
  let clock = T;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const scheduler: Scheduler = {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: clock + ms });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    scheduler,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => [...timers.values()].map((t) => t.at),
  };
}

describe('tickDeadline', () => {
  test('candidate: the auto-detect window; ending: the gap window; both with slack', () => {
    expect(tickDeadline('candidate', T)).toBe(T + CONSTANTS.AUTO_DETECT_WINDOW_S * 1000 + TICK_SLACK_MS);
    expect(tickDeadline('ending', T)).toBe(T + CONSTANTS.GAP_MERGE_S * 1000 + TICK_SLACK_MS);
  });

  test('nothing else has a deadline', () => {
    for (const s of ['off', 'armed', 'recording', 'finalizing'] as const) expect(tickDeadline(s, T)).toBeNull();
  });
});

describe('createTicker: one timeout, to the next deadline only', () => {
  test('no timer while armed, off or recording', () => {
    const m = manual();
    const ticker = createTicker({ now: m.now, scheduler: m.scheduler, onTick: jest.fn() });
    ticker.update('off');
    ticker.update('armed');
    ticker.update('recording');
    expect(m.pending()).toEqual([]);
  });

  test('entering candidate sets exactly one timer; leaving it clears it', () => {
    const m = manual();
    const onTick = jest.fn();
    const ticker = createTicker({ now: m.now, scheduler: m.scheduler, onTick });
    ticker.update('candidate');
    expect(m.pending()).toEqual([T + 180_000 + TICK_SLACK_MS]);
    ticker.update('candidate');
    expect(m.pending()).toHaveLength(1);
    ticker.update('recording');
    expect(m.pending()).toEqual([]);
    m.advance(10 * 60_000);
    expect(onTick).not.toHaveBeenCalled();
  });

  test('the deadline fires one tick with the clock time', () => {
    const m = manual();
    const onTick = jest.fn();
    const ticker = createTicker({ now: m.now, scheduler: m.scheduler, onTick });
    m.advance(5000);
    ticker.update('ending');
    m.advance(600_000 + TICK_SLACK_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(T + 5000 + 600_000 + TICK_SLACK_MS);
    expect(m.pending()).toEqual([]);
  });

  test('still in the same state after the tick: one retry, never a loop of timers', () => {
    const m = manual();
    const onTick = jest.fn();
    const ticker = createTicker({ now: m.now, scheduler: m.scheduler, onTick });
    ticker.update('ending');
    m.advance(600_000 + TICK_SLACK_MS);
    ticker.update('ending');
    expect(m.pending()).toEqual([m.now() + TICK_RETRY_MS]);
  });

  test('a new ending after a resume starts a fresh window', () => {
    const m = manual();
    const ticker = createTicker({ now: m.now, scheduler: m.scheduler, onTick: jest.fn() });
    ticker.update('ending');
    m.advance(60_000);
    ticker.update('recording');
    m.advance(60_000);
    ticker.update('ending');
    expect(m.pending()).toEqual([T + 120_000 + 600_000 + TICK_SLACK_MS]);
  });

  test('stop clears the timer', () => {
    const m = manual();
    const ticker = createTicker({ now: m.now, scheduler: m.scheduler, onTick: jest.fn() });
    ticker.update('candidate');
    ticker.stop();
    expect(m.pending()).toEqual([]);
  });
});
