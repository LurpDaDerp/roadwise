import { MANUAL_TRIGGER } from '@drive-sense';

import { mph, row, T0 } from '@/core/detectors/__fixtures__/rows';
import type { FeatureRow } from '@/core/engine/types';
import {
  createWaitingSession,
  nextWaitingChange,
  WAIT_BUFFER_MS,
  WAIT_COUNTDOWN_MS,
  WAIT_POPUP_MS,
  WAIT_TOTAL_MS,
  waitingDeadline,
  waitingPhaseAt,
} from '@/drive/waiting';

const at = (s: number, over: Partial<FeatureRow>): FeatureRow => row({ ts: T0 + s * 1000, ...over });
const seconds = (from: number, n: number, over: (i: number) => Partial<FeatureRow>) => Array.from({ length: n }, (_, i) => at(from + i, over(i)));

test('the constants: 5 min in all, the sheet at 2:00, the countdown from 4:30, 2 min of rows kept', () => {
  expect([WAIT_TOTAL_MS, WAIT_POPUP_MS, WAIT_COUNTDOWN_MS, WAIT_BUFFER_MS]).toEqual([300_000, 120_000, 270_000, 120_000]);
  expect(MANUAL_TRIGGER).toMatchObject({ mph: 10, holdMs: 15_000 });
});

test('phases on the host clock: waiting, the sheet at 2:00, the countdown at 4:30, over at 5:00; each with its deadline', () => {
  const since = 1_000_000;
  expect(waitingPhaseAt(since, since)).toBe('waiting');
  expect(waitingPhaseAt(since, since + 119_999)).toBe('waiting');
  expect(waitingPhaseAt(since, since + 120_000)).toBe('popup');
  expect(waitingPhaseAt(since, since + 269_999)).toBe('popup');
  expect(waitingPhaseAt(since, since + 270_000)).toBe('countdown');
  expect(waitingPhaseAt(since, since + 299_999)).toBe('countdown');
  expect(waitingPhaseAt(since, since + 300_000)).toBe('expired');
  expect(waitingDeadline(since, 'waiting')).toBe(since + 120_000);
  expect(waitingDeadline(since, 'popup')).toBe(since + 270_000);
  expect(waitingDeadline(since, 'countdown')).toBe(since + 300_000);
  expect(nextWaitingChange(since, since + 10)).toBe(since + 120_000);
  expect(nextWaitingChange(since, since + 280_000)).toBe(since + 300_000);
  // A touch is a new `since`: the wait starts over.
  expect(waitingPhaseAt(since + 250_000, since + 280_000)).toBe('waiting');
});

describe('the Android confirmation (10 mph held 15 s)', () => {
  test('parked, then pulling away: confirmed on the row 15 s into the run, started at the last stop before the rise', () => {
    const w = createWaitingSession();
    const parked = seconds(0, 30, () => ({ speed: 0 }));
    const rise = seconds(30, 5, (i) => ({ speed: mph(2 + 2 * i) }));
    const fast = seconds(35, 30, () => ({ speed: mph(20) }));
    const out = [...parked, ...rise, ...fast].map((r) => w.push(r));
    const k = out.findIndex((c) => c !== null);
    // The run (≥ 10 mph) starts in the rise at 33 s (2 + 2·3 = 8 mph at 33 s, 10 at 34 s); confirmed 15 s later.
    expect(k).toBe(34 + 15);
    const c = out[k]!;
    expect(c).toMatchObject({ startSource: 'trace', startedAt: T0 + 30_000 });
    expect(c.rows[0]!.ts).toBe(T0 + 30_000);
    expect(c.rows.at(-1)!.ts).toBe(T0 + 49_000);
    // One confirmation per session.
    expect(w.push(at(70, { speed: mph(20) }))).toBeNull();
  });

  test('a dip under 10 mph spanning 5 s keeps the hold; one spanning 6 s starts it again', () => {
    const run = (dip: number) => {
      const w = createWaitingSession();
      const rows = [...seconds(0, 5, () => ({ speed: 0 })), ...seconds(5, 8, () => ({ speed: mph(15) })), ...seconds(13, dip, () => ({ speed: mph(5) })), ...seconds(13 + dip, 30, () => ({ speed: mph(15) }))];
      return rows.findIndex((r) => w.push(r) !== null);
    };
    // Six slow rows (13..18 s) span 5 s: kept, confirmed 15 s after the run began at 5 s.
    expect(run(6)).toBe(20);
    // Seven (13..19 s) span 6 s: broken; the run starts again at 20 s and confirms 15 s later.
    expect(run(7)).toBe(20 + 15);
  });

  test('fixes worse than 30 m never confirm', () => {
    const w = createWaitingSession();
    expect(seconds(0, 60, () => ({ speed: mph(30), hAcc: 40 })).some((r) => w.push(r) !== null)).toBe(false);
  });

  test('a buffer that begins already moving starts at its first row (wake)', () => {
    const w = createWaitingSession();
    const rows = seconds(0, 40, () => ({ speed: mph(25) }));
    const c = rows.map((r) => w.push(r)).find((x) => x !== null)!;
    expect(c).toMatchObject({ startSource: 'wake', startedAt: T0 });
    expect(c.rows).toHaveLength(16);
  });

  test('only the newest 2 min of rows are kept; a repeated or older row is ignored', () => {
    const w = createWaitingSession();
    for (const r of seconds(0, 200, () => ({ speed: 0 }))) w.push(r);
    expect(w.buffered()[0]!.ts).toBe(T0 + (199 - 120) * 1000);
    expect(w.push(at(10, { speed: mph(30) }))).toBeNull();
    expect(w.buffered().at(-1)!.ts).toBe(T0 + 199_000);
  });
});
