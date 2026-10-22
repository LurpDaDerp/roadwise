// The phone's heading for the driving screen's compass before the drive's first track bearing
// (round 8 plan, decision 7): which reading counts, the smoothing, the subscription's life, and the
// rule that a drive never goes back from its track bearing.
import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  compassHeadingOf,
  DEVICE_HEADING_ALPHA,
  DEVICE_HEADING_SETTLE_DEG,
  DEVICE_HEADING_STEP_DEG,
  DEVICE_HEADING_TICK_MS,
  deviceHeadingWanted,
  headingDelta,
  headingOf,
  type HeadingFilter,
  NO_HEADING,
  nextHeldTrack,
  readHeading,
  tickHeading,
  useDeviceHeading,
} from '../useDeviceHeading';

type Sub = { cb: (h: unknown) => void; onError?: (reason: string) => void; removed: boolean };
const mockSubs: Sub[] = [];
/** How the fake phone answers the next `watchHeadingAsync`: at once, never (a pending promise), or refused. */
let mockAnswer: 'ok' | 'hold' | 'refuse' = 'ok';
let mockRelease: (() => void) | null = null;
jest.mock('expo-location', () => ({
  watchHeadingAsync: jest.fn((cb: (h: unknown) => void, onError?: (reason: string) => void) => {
    const sub: Sub = { cb, onError, removed: false };
    const handle = {
      remove: () => {
        sub.removed = true;
      },
    };
    if (mockAnswer === 'refuse') return Promise.reject(new Error('Location permission not granted'));
    mockSubs.push(sub);
    if (mockAnswer === 'hold') return new Promise((resolve) => (mockRelease = () => resolve(handle)));
    return Promise.resolve(handle);
  }),
}));

const open = () => mockSubs.filter((s) => !s.removed);
const emit = async (h: { trueHeading: number; magHeading: number; accuracy: number }) => {
  await act(async () => open().at(-1)!.cb(h));
};
const good = (deg: number) => ({ trueHeading: deg, magHeading: deg, accuracy: 3 });

const seen: (number | null)[] = [];
function Probe({ on }: { on: boolean }) {
  const h = useDeviceHeading(on);
  seen.push(h);
  return <Text testID="h">{h === null ? 'none' : String(h)}</Text>;
}
const last = () => seen.at(-1);

/** The hook's tick intervals: each one started and not yet cleared (over the fake timers). */
function ticks(): { live(): number; restore(): void } {
  const started = new Set<unknown>();
  const origSet = globalThis.setInterval;
  const origClear = globalThis.clearInterval;
  const set = jest.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
    const id = origSet(fn, ms);
    started.add(id);
    return id;
  }) as unknown as typeof setInterval);
  const clear = jest.spyOn(globalThis, 'clearInterval').mockImplementation(((id: ReturnType<typeof setInterval>) => {
    started.delete(id);
    origClear(id);
  }) as unknown as typeof clearInterval);
  return {
    live: () => started.size,
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSubs.length = 0;
  seen.length = 0;
  mockAnswer = 'ok';
  mockRelease = null;
});
afterEach(() => jest.useRealTimers());

describe('headingOf: which reading counts', () => {
  test('true north when known, else magnetic', () => {
    expect(headingOf({ trueHeading: 12.5, magHeading: 20, accuracy: 3 })).toBe(12.5);
    expect(headingOf({ trueHeading: 0, magHeading: 20, accuracy: 1 })).toBe(0);
    expect(headingOf({ trueHeading: -1, magHeading: 20, accuracy: 2 })).toBe(20);
  });

  test('an uncalibrated (accuracy 0), invalid or missing reading is passed over', () => {
    expect(headingOf({ trueHeading: 10, magHeading: 10, accuracy: 0 })).toBeNull();
    expect(headingOf({ trueHeading: 10, magHeading: 10, accuracy: -1 })).toBeNull();
    expect(headingOf({ trueHeading: 10, magHeading: 10 })).toBeNull();
    expect(headingOf({ trueHeading: 10, magHeading: 10, accuracy: Number.NaN })).toBeNull();
    expect(headingOf({ trueHeading: -1, magHeading: -1, accuracy: 3 })).toBeNull();
    expect(headingOf({ trueHeading: Number.NaN, magHeading: Number.POSITIVE_INFINITY, accuracy: 3 })).toBeNull();
    expect(headingOf({ trueHeading: '10', magHeading: null, accuracy: 3 })).toBeNull();
    expect(headingOf(null)).toBeNull();
    expect(headingOf(undefined)).toBeNull();
  });

  test('normalised to [0, 360): 360 is north', () => {
    expect(headingOf({ trueHeading: 360, magHeading: 1, accuracy: 3 })).toBe(0);
    expect(headingOf({ trueHeading: 725, magHeading: 1, accuracy: 3 })).toBe(5);
  });
});

test('headingDelta: the signed short way, across north too', () => {
  expect(headingDelta(350, 10)).toBe(20);
  expect(headingDelta(10, 350)).toBe(-20);
  expect(headingDelta(0, 180)).toBe(180);
  expect(headingDelta(90, 90)).toBe(0);
  expect(headingDelta(0, 270)).toBe(-90);
});

describe('the smoothing', () => {
  const run = (f: HeadingFilter, n: number) => {
    let x = f;
    for (let i = 0; i < n; i += 1) x = tickHeading(x);
    return x;
  };

  test('the constants', () => {
    expect([DEVICE_HEADING_TICK_MS, DEVICE_HEADING_ALPHA, DEVICE_HEADING_STEP_DEG, DEVICE_HEADING_SETTLE_DEG]).toEqual([250, 0.4, 3, 0.5]);
  });

  test('the first reading shows at once; later ones wait for a tick', () => {
    const f = readHeading(NO_HEADING, 90);
    expect(f).toEqual({ raw: 90, smoothed: 90, shown: 90 });
    const g = readHeading(f, 120);
    expect(g).toEqual({ raw: 120, smoothed: 90, shown: 90 });
  });

  test('a turn: the shown heading follows in steps of 3° or more and ends exactly where the phone points', () => {
    let f = readHeading(readHeading(NO_HEADING, 90), 180);
    const shown: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const next = tickHeading(f);
      if (next.shown !== f.shown) shown.push(next.shown!);
      f = next;
    }
    expect(f.shown).toBe(180);
    expect(shown[0]).toBeCloseTo(90 + 0.4 * 90, 9);
    for (let i = 1; i < shown.length; i += 1) expect(shown[i]! > shown[i - 1]!).toBe(true);
    // settled: nothing more changes, and the same object comes back
    expect(tickHeading(f)).toBe(f);
  });

  test('through north the short way', () => {
    const f = run(readHeading(readHeading(NO_HEADING, 350), 20), 1);
    expect(f.smoothed).toBeCloseTo(2, 9);
    expect(run(f, 40).shown).toBe(20);
  });

  test('noise under the step never moves the shown heading until it settles', () => {
    let f = readHeading(NO_HEADING, 90);
    f = tickHeading(readHeading(f, 91.5));
    // 0.6 of the way there after one tick: not settled, under 3°
    expect(f.shown).toBe(90);
    f = run(f, 20);
    expect(f.shown).toBe(91.5);
  });

  test('nothing to do with no reading', () => {
    expect(tickHeading(NO_HEADING)).toBe(NO_HEADING);
  });
});

describe('the held track bearing', () => {
  test('the newest track bearing; the same one keeps its object', () => {
    const a = nextHeldTrack(null, 30, 't1');
    expect(a).toEqual({ tripId: 't1', deg: 30 });
    expect(nextHeldTrack(a, 30, 't1')).toBe(a);
    expect(nextHeldTrack(a, 31, 't1')).toEqual({ tripId: 't1', deg: 31 });
  });

  test('held when the bearing goes (never back to the phone that drive), also once the id is cleared', () => {
    const a = nextHeldTrack(null, 30, 't1');
    expect(nextHeldTrack(a, null, 't1')).toBe(a);
    expect(nextHeldTrack(a, null, null)).toBe(a);
  });

  test('a new drive starts afresh', () => {
    const a = nextHeldTrack(null, 30, 't1');
    expect(nextHeldTrack(a, null, 't2')).toBeNull();
    expect(nextHeldTrack(a, 200, 't2')).toEqual({ tripId: 't2', deg: 200 });
  });

  test('a non-finite bearing is none', () => {
    expect(nextHeldTrack(null, Number.NaN, 't1')).toBeNull();
  });

  test('the compass heading: the track bearing, else the phone, else none', () => {
    expect(compassHeadingOf({ tripId: 't1', deg: 10 }, 99)).toBe(10);
    expect(compassHeadingOf(null, 99)).toBe(99);
    expect(compassHeadingOf(null, null)).toBeNull();
  });

  test('the phone is read only on iOS, focused, in front, recording, with the ring, in portrait, with no track bearing', () => {
    const all = { ios: true, focused: true, active: true, recording: true, ring: true, portrait: true, hasTrack: false };
    expect(deviceHeadingWanted(all)).toBe(true);
    for (const k of ['ios', 'focused', 'active', 'recording', 'ring', 'portrait'] as const) expect(deviceHeadingWanted({ ...all, [k]: false })).toBe(false);
    expect(deviceHeadingWanted({ ...all, hasTrack: true })).toBe(false);
  });
});

describe('useDeviceHeading', () => {
  test('disabled: never subscribes, null', async () => {
    await render(<Probe on={false} />);
    await act(async () => {});
    expect(mockSubs).toHaveLength(0);
    expect(last()).toBeNull();
  });

  test('enabled: the first good reading at once, then smoothed on the ticks; uncalibrated readings ignored', async () => {
    await render(<Probe on />);
    await act(async () => {});
    expect(open()).toHaveLength(1);
    expect(last()).toBeNull();
    await emit({ trueHeading: 50, magHeading: 50, accuracy: 0 });
    expect(last()).toBeNull();
    await emit(good(50));
    expect(last()).toBe(50);
    await emit(good(140));
    expect(last()).toBe(50);
    await act(() => jest.advanceTimersByTime(DEVICE_HEADING_TICK_MS));
    expect(last()).toBeCloseTo(86, 9);
    await act(() => jest.advanceTimersByTime(DEVICE_HEADING_TICK_MS * 30));
    expect(last()).toBe(140);
  });

  test('disabled again: the subscription is removed, null at once; enabled again: a fresh one', async () => {
    const r = await render(<Probe on />);
    await act(async () => {});
    await emit(good(10));
    await r.rerender(<Probe on={false} />);
    expect(last()).toBeNull();
    expect(open()).toHaveLength(0);
    await act(() => jest.advanceTimersByTime(5000));
    expect(last()).toBeNull();
    await r.rerender(<Probe on />);
    await act(async () => {});
    expect(open()).toHaveLength(1);
    expect(mockSubs).toHaveLength(2);
    // it starts afresh: no stale heading
    expect(last()).toBeNull();
  });

  test('unmount removes the subscription and stops the ticks', async () => {
    const t = ticks();
    const r = await render(<Probe on />);
    await act(async () => {});
    await emit(good(10));
    expect(t.live()).toBe(1);
    await r.unmount();
    expect(open()).toHaveLength(0);
    expect(t.live()).toBe(0);
    t.restore();
  });

  test('disabled before the subscription arrived: it is removed as soon as it does', async () => {
    mockAnswer = 'hold';
    const r = await render(<Probe on />);
    await act(async () => {});
    expect(mockSubs).toHaveLength(1);
    await r.rerender(<Probe on={false} />);
    await act(async () => mockRelease!());
    expect(open()).toHaveLength(0);
  });

  test('a refused permission (or no compass) is silent: null, nothing left running', async () => {
    mockAnswer = 'refuse';
    const t = ticks();
    await render(<Probe on />);
    await act(async () => {});
    expect(last()).toBeNull();
    expect(t.live()).toBe(0);
    t.restore();
  });

  test('the stream failing: null, ticks stopped, the subscription let go', async () => {
    const t = ticks();
    await render(<Probe on />);
    await act(async () => {});
    await emit(good(200));
    expect(last()).toBe(200);
    await act(async () => open().at(-1)!.onError?.('heading unavailable'));
    expect(last()).toBeNull();
    expect(open()).toHaveLength(0);
    expect(t.live()).toBe(0);
    t.restore();
  });

  test('a stream that fails before its subscription arrives: the subscription is let go as it lands, later readings ignored', async () => {
    mockAnswer = 'hold';
    await render(<Probe on />);
    await act(async () => {});
    const sub = mockSubs[0]!;
    await act(async () => sub.onError?.('heading unavailable'));
    await act(async () => mockRelease!());
    expect(sub.removed).toBe(true);
    await act(async () => sub.cb(good(40)));
    expect(last()).toBeNull();
  });

  test('a reading after removal is ignored', async () => {
    const r = await render(<Probe on />);
    await act(async () => {});
    const sub = mockSubs[0]!;
    await r.rerender(<Probe on={false} />);
    await act(async () => sub.cb(good(77)));
    expect(last()).toBeNull();
  });
});
