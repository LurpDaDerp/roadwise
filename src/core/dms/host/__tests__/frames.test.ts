// Decoded wire records → EngineFrames (plan Task 14): the flags pick the nulls (a clipped eye, a missing
// pose, the net, the mouth), and the record clock moves onto the epoch by the session's anchor offset.
import { buildFrameBatch, decodeFrameBatch, recordFromFeatures, type FrameFeatures } from '../../../../../modules/dms-vision/src/wire';
import { frame } from '../../engine/__fixtures__/synth';
import { featuresFromFrame } from '../__fixtures__/records';
import { engineFrame } from '../frames';

const OFFSET = 1_760_000_000_000;

test('a full frame survives features → record → wire → decode → EngineFrame (on the epoch clock)', () => {
  const f = frame({ tMs: 5000, net: { yaw: 3, pitch: -2 }, head: { yaw: 5, pitch: -4, roll: 1 } });
  const batch = buildFrameBatch([recordFromFeatures(featuresFromFrame(f))], OFFSET + 5000);
  const decoded = decodeFrameBatch(batch).batch!.frames[0]!;
  const e = engineFrame(decoded, OFFSET);
  expect(e.tMs).toBe(OFFSET + 5000);
  expect(e.head).toEqual({ yaw: 5, pitch: -4, roll: 1 });
  expect(e.net).toEqual({ yaw: expect.closeTo(3, 5), pitch: expect.closeTo(-2, 5) });
  expect(e.eyeR!.irisIn).toBe(true);
  expect(e.eyeR!.ear).toBeCloseTo(f.eyeR!.ear, 5);
  expect(e.mouth!.mar).toBeCloseTo(0.08, 5);
});

test('the flags: no net, a clipped eye, a missing pose, a clipped mouth', () => {
  const f = frame({ tMs: 100, eyeL: null, poseMissing: true });
  const feat: FrameFeatures = { ...featuresFromFrame({ ...f, mouth: null }) };
  const e = engineFrame(feat, 0);
  expect(e.net).toBeNull();
  expect(e.eyeL).toBeNull();
  expect(e.eyeR).not.toBeNull();
  expect(e.head).toBeNull();
  expect(e.mouth).toBeNull();
});

test('no face: every face field null', () => {
  const e = engineFrame(featuresFromFrame(frame({ tMs: 0, face: false, frameLuma: 12 })), 0);
  expect(e).toMatchObject({ face: false, box: null, iod: null, head: null, eyeR: null, eyeL: null, mouth: null, frameLuma: 12 });
});
