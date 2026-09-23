// The frames wire (plan "Wire contract v1", rev1: I9, rev2: R1-I1): 38 little-endian float32 per
// record, a per-field NaN mask that is REQUIRED in both directions, and per-record drops so one bad
// record never costs the batch. Every rule below has a positive case and a rejection.
import {
  ALLOWED_ROTATIONS,
  FLAG,
  FRAME_BYTES,
  FRAME_FIELDS,
  FRAME_MASK,
  FRAME_STRIDE,
  FRAME_WIRE_VERSION,
} from '../src/constants';
import {
  buildFrameBatch,
  decodeFrameBatch,
  encodeFrameBatch,
  faceAbsentRecord,
  recordFromFeatures,
} from '../src/wire';

const idx = (name: (typeof FRAME_FIELDS)[number]) => FRAME_FIELDS.indexOf(name);

/** A fully tracked face in absolute form (field 0 = tMs): every field finite, no flags. */
function tracked(tMs: number): number[] {
  const r: number[] = new Array(FRAME_STRIDE).fill(0.5);
  r[idx('tOffMs')] = tMs;
  r[idx('face')] = 1;
  r[idx('netYaw')] = NaN; // no NET_RAN
  r[idx('netPitch')] = NaN;
  r[idx('irisInR')] = 1;
  r[idx('irisInL')] = 1;
  r[idx('rotationDeg')] = 90;
  r[idx('latLandmarkMs')] = 12;
  r[idx('latTotalMs')] = 20;
  r[idx('flags')] = 0;
  r[idx('reserved')] = 0;
  return r;
}

/** A wire batch anchored at the first record (as native anchors it), with header overrides. */
function batch(records: number[][], over: Record<string, unknown> = {}) {
  return { ...buildFrameBatch(records, 1_700_000_000_000), ...over };
}

const R_FIELDS = ['earR', 'eyeWR', 'eyeLumaR', 'irisContrastR', 'eyeSatR', 'irisOxR', 'irisOyR'] as const;
const L_FIELDS = ['earL', 'eyeWL', 'eyeLumaL', 'irisContrastL', 'eyeSatL', 'irisOxL', 'irisOyL'] as const;
const F_FIELDS = ['boxCx', 'boxCy', 'boxW', 'boxH', 'iod', 'irisInR', 'irisInL', 'faceLuma', 'blur'] as const;

describe('constants', () => {
  test('38 fields, 152 bytes, one mask class per field, no duplicates', () => {
    expect(FRAME_STRIDE).toBe(38);
    expect(FRAME_BYTES).toBe(152);
    expect(FRAME_WIRE_VERSION).toBe(1);
    expect(FRAME_FIELDS).toHaveLength(38);
    expect(FRAME_MASK).toHaveLength(38);
    expect(new Set(FRAME_FIELDS).size).toBe(38);
    expect(FRAME_FIELDS[0]).toBe('tOffMs');
    expect(FRAME_FIELDS[37]).toBe('reserved');
  });

  test('the mask classes are the plan table', () => {
    const cls = (n: (typeof FRAME_FIELDS)[number]) => FRAME_MASK[idx(n)];
    for (const n of ['tOffMs', 'face', 'frameLuma', 'rotationDeg', 'latLandmarkMs', 'latTotalMs', 'flags', 'reserved'] as const)
      expect(cls(n)).toBe('A');
    for (const n of F_FIELDS) expect(cls(n)).toBe('F');
    for (const n of ['headYaw', 'headPitch', 'headRoll'] as const) expect(cls(n)).toBe('P');
    for (const n of ['netYaw', 'netPitch'] as const) expect(cls(n)).toBe('N');
    for (const n of R_FIELDS) expect(cls(n)).toBe('R');
    for (const n of L_FIELDS) expect(cls(n)).toBe('L');
    for (const n of ['mar', 'mouthW'] as const) expect(cls(n)).toBe('M');
  });

  test('flags and rotations', () => {
    expect(FLAG).toEqual({ NET_RAN: 1, EYE_CLIPPED_R: 2, EYE_CLIPPED_L: 4, MOUTH_CLIPPED: 8, POSE_MISSING: 16 });
    expect(ALLOWED_ROTATIONS).toEqual([0, 90, 180, 270]);
  });
});

describe('decode: the happy paths', () => {
  test('a tracked record round-trips (float32 precision) and NaN decodes to null', () => {
    const r = tracked(1234.5);
    const out = decodeFrameBatch(batch([r]));
    expect(out.droppedBatch).toBe(false);
    expect(out.droppedRecords).toBe(0);
    const f = out.batch!.frames[0]!;
    expect(f.tMs).toBe(1234.5);
    expect(f.face).toBe(true);
    expect(f.headYaw).toBeCloseTo(0.5, 6);
    expect(f.netYaw).toBeNull();
    expect(f.rotationDeg).toBe(90);
    expect(f.flags).toBe(0);
    expect(out.batch!.anchorTMs).toBe(1234.5);
    expect(out.batch!.anchorEpochMs).toBe(1_700_000_000_000);
    expect(out.lastTMs).toBe(1234.5);
  });

  test('a face-absent record decodes (every masked field null, frameLuma kept)', () => {
    const out = decodeFrameBatch(batch([faceAbsentRecord(500, 12, 0, 9, 11)]));
    expect(out.droppedRecords).toBe(0);
    const f = out.batch!.frames[0]!;
    expect(f.face).toBe(false);
    expect(f.frameLuma).toBe(12);
    expect(f.boxCx).toBeNull();
    expect(f.headYaw).toBeNull();
    expect(f.earR).toBeNull();
    expect(f.mar).toBeNull();
    expect(f.irisInR).toBeNull();
  });

  test('a face-absent record mixed into a batch never poisons it', () => {
    const out = decodeFrameBatch(batch([tracked(1), faceAbsentRecord(2, 30, 90, 9, 11), tracked(3)]));
    expect(out.droppedRecords).toBe(0);
    expect(out.batch!.frames.map((f) => f.face)).toEqual([true, false, true]);
  });

  test('NET_RAN carries a finite net gaze', () => {
    const r = tracked(1);
    r[idx('flags')] = FLAG.NET_RAN;
    r[idx('netYaw')] = -12.5;
    r[idx('netPitch')] = 3.25;
    const f = decodeFrameBatch(batch([r])).batch!.frames[0]!;
    expect(f.netYaw).toBe(-12.5);
    expect(f.netPitch).toBe(3.25);
    expect(f.flags).toBe(FLAG.NET_RAN);
  });

  test.each([
    ['EYE_CLIPPED_R', FLAG.EYE_CLIPPED_R, R_FIELDS, 'irisInR'],
    ['EYE_CLIPPED_L', FLAG.EYE_CLIPPED_L, L_FIELDS, 'irisInL'],
  ] as const)('%s: that eye is NaN (null) and its irisIn is 0', (_n, flag, fields, irisIn) => {
    const r = tracked(1);
    r[idx('flags')] = flag;
    for (const n of fields) r[idx(n)] = NaN;
    r[idx(irisIn)] = 0;
    const out = decodeFrameBatch(batch([r]));
    expect(out.droppedRecords).toBe(0);
    const f = out.batch!.frames[0]!;
    for (const n of fields) expect(f[n]).toBeNull();
  });

  test('MOUTH_CLIPPED and POSE_MISSING', () => {
    const m = tracked(1);
    m[idx('flags')] = FLAG.MOUTH_CLIPPED;
    m[idx('mar')] = NaN;
    m[idx('mouthW')] = NaN;
    const p = tracked(2);
    p[idx('flags')] = FLAG.POSE_MISSING;
    for (const n of ['headYaw', 'headPitch', 'headRoll'] as const) p[idx(n)] = NaN;
    const out = decodeFrameBatch(batch([m, p]));
    expect(out.droppedRecords).toBe(0);
    expect(out.batch!.frames[0]!.mar).toBeNull();
    expect(out.batch!.frames[1]!.headRoll).toBeNull();
  });

  test('recordFromFeatures inverts decode', () => {
    const r = tracked(77);
    const f = decodeFrameBatch(batch([r])).batch!.frames[0]!;
    const back = recordFromFeatures(f);
    const again = decodeFrameBatch(batch([back])).batch!.frames[0]!;
    expect(again).toEqual(f);
  });

  test('an unaligned view is copied, not misread', () => {
    const b = batch([tracked(5)]);
    const padded = new Uint8Array(b.data.byteLength + 1);
    padded.set(b.data, 1);
    const view = new Uint8Array(padded.buffer, 1, b.data.byteLength);
    const out = decodeFrameBatch({ ...b, data: view });
    expect(out.droppedBatch).toBe(false);
    expect(out.batch!.frames[0]!.tMs).toBe(5);
  });

  test('the payload may also arrive as an ArrayBuffer or another typed-array view (review m3)', () => {
    const b = batch([tracked(5), tracked(6)]);
    const copy = b.data.slice().buffer;
    expect(decodeFrameBatch({ ...b, data: copy }).batch!.frames.map((f) => f.tMs)).toEqual([5, 6]);
    const asInt8 = new Int8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    expect(decodeFrameBatch({ ...b, data: asInt8 }).batch!.frames.map((f) => f.tMs)).toEqual([5, 6]);
  });
});

describe('time: tOffMs against a float64 anchor (Task 1 review C1)', () => {
  const WEEK_MS = 6.048e8; // a week of uptime: float32 steps by 64 ms here
  const PERIOD = 1000 / 15; // 66.666… ms at 15 fps

  test('a week-uptime clock keeps sub-microsecond durations', () => {
    const times = Array.from({ length: 10 }, (_, k) => WEEK_MS + 0.123 + k * PERIOD);
    const out = decodeFrameBatch(batch(times.map(tracked)));
    expect(out.droppedRecords).toBe(0);
    const got = out.batch!.frames.map((f) => f.tMs);
    expect(out.batch!.anchorTMs).toBe(times[0]);
    for (let k = 0; k < times.length; k++) expect(Math.abs(got[k]! - times[k]!)).toBeLessThan(1e-4);
    for (let k = 1; k < times.length; k++) expect(Math.abs(got[k]! - got[k - 1]! - PERIOD)).toBeLessThan(1e-4);
  });

  test('the same holds across batches of one session', () => {
    const a = [0, 1, 2].map((k) => WEEK_MS + k * PERIOD);
    const b = [3, 4, 5].map((k) => WEEK_MS + k * PERIOD);
    const first = decodeFrameBatch(batch(a.map(tracked)));
    const second = decodeFrameBatch(batch(b.map(tracked)), first.lastTMs);
    expect(second.droppedRecords).toBe(0);
    expect(Math.abs(second.batch!.frames[0]!.tMs - first.lastTMs! - PERIOD)).toBeLessThan(1e-4);
  });

  test('a negative tOffMs (a record earlier than the anchor) is dropped', () => {
    const b = batch([tracked(100), tracked(50)]);
    const out = decodeFrameBatch(b);
    expect(out.droppedRecords).toBe(1);
    expect(out.batch!.frames.map((f) => f.tMs)).toEqual([100]);
  });

  test('a negative anchor is a broken header', () => {
    expect(decodeFrameBatch(batch([tracked(1)], { anchorTMs: -5 })).droppedBatch).toBe(true);
  });
});


describe('decode: the mask is required in BOTH directions (one bad record dropped, the rest kept)', () => {
  function expectDropped(mutate: (r: number[]) => void) {
    const bad = tracked(2);
    mutate(bad);
    const out = decodeFrameBatch(batch([tracked(1), bad, tracked(3)]));
    expect(out.droppedBatch).toBe(false);
    expect(out.droppedRecords).toBe(1);
    expect(out.batch!.frames.map((f) => f.tMs)).toEqual([1, 3]);
  }

  test.each(['tOffMs', 'face', 'frameLuma', 'rotationDeg', 'latLandmarkMs', 'latTotalMs', 'flags', 'reserved'] as const)(
    'A: NaN in %s',
    (n) => expectDropped((r) => (r[idx(n)] = NaN))
  );
  test.each(F_FIELDS)('F: NaN in %s with a face', (n) => expectDropped((r) => (r[idx(n)] = NaN)));
  test.each(F_FIELDS)('F: a finite %s without a face', (n) =>
    expectDropped((r) => {
      const a = faceAbsentRecord(2, 30, 90, 9, 11);
      for (let i = 0; i < a.length; i++) r[i] = a[i]!;
      r[idx(n)] = 0.25;
    })
  );
  test.each(['headYaw', 'headPitch', 'headRoll'] as const)('P: NaN in %s without POSE_MISSING', (n) =>
    expectDropped((r) => (r[idx(n)] = NaN))
  );
  test('P: a finite pose with POSE_MISSING', () =>
    expectDropped((r) => {
      r[idx('flags')] = FLAG.POSE_MISSING;
    }));
  test('N: a finite net gaze without NET_RAN', () => expectDropped((r) => (r[idx('netYaw')] = 1)));
  test('N: NET_RAN with a NaN net gaze', () => expectDropped((r) => (r[idx('flags')] = FLAG.NET_RAN)));
  test.each(R_FIELDS)('R: NaN in %s without EYE_CLIPPED_R', (n) => expectDropped((r) => (r[idx(n)] = NaN)));
  test.each(L_FIELDS)('L: NaN in %s without EYE_CLIPPED_L', (n) => expectDropped((r) => (r[idx(n)] = NaN)));
  test('R: a finite right eye with EYE_CLIPPED_R', () =>
    expectDropped((r) => {
      r[idx('flags')] = FLAG.EYE_CLIPPED_R;
      r[idx('irisInR')] = 0;
    }));
  test('R: EYE_CLIPPED_R with irisInR = 1', () =>
    expectDropped((r) => {
      r[idx('flags')] = FLAG.EYE_CLIPPED_R;
      for (const n of R_FIELDS) r[idx(n)] = NaN;
    }));
  test.each(['mar', 'mouthW'] as const)('M: NaN in %s without MOUTH_CLIPPED', (n) =>
    expectDropped((r) => (r[idx(n)] = NaN))
  );
  test('M: a finite mouth with MOUTH_CLIPPED', () => expectDropped((r) => (r[idx('flags')] = FLAG.MOUTH_CLIPPED)));

  test.each([
    ['+Infinity in headYaw', (r: number[]) => (r[idx('headYaw')] = Infinity)],
    ['-Infinity in tOffMs', (r: number[]) => (r[idx('tOffMs')] = -Infinity)],
    ['face = 0.5', (r: number[]) => (r[idx('face')] = 0.5)],
    ['flags = 32 (no such bit)', (r: number[]) => (r[idx('flags')] = 32)],
    ['flags = 1.5', (r: number[]) => (r[idx('flags')] = 1.5)],
    ['reserved = 1', (r: number[]) => (r[idx('reserved')] = 1)],
    ['rotationDeg = 45', (r: number[]) => (r[idx('rotationDeg')] = 45)],
    ['irisInR = 0.5', (r: number[]) => (r[idx('irisInR')] = 0.5)],
    ['a negative latency', (r: number[]) => (r[idx('latTotalMs')] = -1)],
    ['a time before the anchor (negative tOffMs)', (r: number[]) => (r[idx('tOffMs')] = -1)],
  ])('%s', (_n, mutate) => expectDropped(mutate));

  test('flags must be 0 when there is no face', () =>
    expectDropped((r) => {
      const a = faceAbsentRecord(2, 30, 90, 9, 11);
      for (let i = 0; i < a.length; i++) r[i] = a[i]!;
      r[idx('flags')] = FLAG.NET_RAN;
    }));

  test('a record earlier than the previous accepted one is dropped (equal is kept)', () => {
    const out = decodeFrameBatch(batch([tracked(10), tracked(10), tracked(9), tracked(11)]));
    expect(out.droppedRecords).toBe(1);
    expect(out.batch!.frames.map((f) => f.tMs)).toEqual([10, 10, 11]);
  });

  test('monotonic across batches through lastTMs', () => {
    const out = decodeFrameBatch(batch([tracked(4), tracked(6)]), 5);
    expect(out.droppedRecords).toBe(1);
    expect(out.batch!.frames.map((f) => f.tMs)).toEqual([6]);
    expect(out.lastTMs).toBe(6);
  });
});

describe('decode: header failures drop the batch', () => {
  test.each([
    ['not an object', null],
    ['wrong version', { v: 2 }],
    ['n does not match the bytes', { n: 2 }],
    ['n = 0', { n: 0, data: new Uint8Array(0) }],
    ['n not an integer', { n: 1.5 }],
    ['data not a Uint8Array', { data: [1, 2, 3] }],
    ['a length that is not a multiple of 152', { data: new Uint8Array(151) }],
    ['a non-finite anchor', { anchorTMs: NaN }],
    ['a non-finite epoch anchor', { anchorEpochMs: Infinity }],
    ['an unknown key', { extra: 1 }],
  ])('%s', (_n, over) => {
    const raw = over === null ? null : batch([tracked(1)], over as Record<string, unknown>);
    const out = decodeFrameBatch(raw);
    expect(out.droppedBatch).toBe(true);
    expect(out.batch).toBeNull();
  });

  test('a batch whose every record fails keeps droppedBatch false and returns no frames', () => {
    const bad = tracked(1);
    bad[idx('reserved')] = 3;
    const out = decodeFrameBatch(batch([bad]));
    expect(out.droppedBatch).toBe(false);
    expect(out.droppedRecords).toBe(1);
    expect(out.batch!.frames).toEqual([]);
  });
});

test('the encoder writes little-endian float32 at 152-byte strides', () => {
  const data = encodeFrameBatch([tracked(1), tracked(2)]);
  expect(data.byteLength).toBe(2 * FRAME_BYTES);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  expect(view.getFloat32(0, true)).toBe(1);
  expect(view.getFloat32(FRAME_BYTES, true)).toBe(2);
  expect(() => encodeFrameBatch([[1, 2, 3]])).toThrow(/38/);
});
