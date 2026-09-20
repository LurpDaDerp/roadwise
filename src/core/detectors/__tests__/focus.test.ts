import { CONSTANTS } from '@scoring';
import { createFocusDetector } from '@/core/detectors/focus';
import type { CameraFocusSample } from '@/core/engine/types';
import { T0, counterIds, ctx, limit, mph, only, row } from '../__fixtures__/rows';

const L = limit(mph(35));
const make = () => createFocusDetector(counterIds());
const glance = (glanceS: number, extra: Partial<CameraFocusSample> = {}) =>
  ctx({ cameraFocus: { glanceS, kind: 'glance', q: 0.9, ...extra } });

test('a closed glance ≥ EYES_OFF_S at ≥ EYES_OFF_MIN_SPEED_MPS is a focus event on that row', () => {
  const e = only(make().push(row({}, 4), L, glance(2.5)));
  expect(e).toMatchObject({
    id: 'e1',
    category: 'focus',
    startedAt: T0 + 4000 - 2500,
    durationS: 2.5,
    q: 0.9,
    corrected: false,
    status: 'scored',
    alertable: true,
    source: 'camera',
    measured: { glanceS: 2.5, focusKind: 'glance', speedMps: 15 },
    context: { night: false, precipitation: false },
  });
});

test('no camera sample, no event', () => {
  expect(make().push(row(), L, ctx())).toEqual([]);
  expect(make().push(row(), L, ctx({ cameraFocus: null }))).toEqual([]);
});

test('glances shorter than EYES_OFF_S are ignored; exactly EYES_OFF_S counts', () => {
  expect(make().push(row(), L, glance(1.9))).toEqual([]);
  expect(make().push(row(), L, glance(CONSTANTS.EYES_OFF_S))).toHaveLength(1);
});

test('glances below EYES_OFF_MIN_SPEED_MPS or at an unknown speed are ignored; exactly at it counts', () => {
  expect(make().push(row({ speed: 4 }), L, glance(3))).toEqual([]);
  expect(make().push(row({ gnssValid: false }), L, glance(3))).toEqual([]);
  expect(make().push(row({ speed: CONSTANTS.EYES_OFF_MIN_SPEED_MPS }), L, glance(3))).toHaveLength(1);
});

test('drowsiness has no speed or length gate', () => {
  const sample: CameraFocusSample = { glanceS: 0, kind: 'drowsiness', q: 0.7 };
  const e = only(make().push(row({ speed: 0 }), L, ctx({ cameraFocus: sample })));
  expect(e).toMatchObject({
    category: 'focus',
    startedAt: T0,
    durationS: 0,
    q: 0.7,
    status: 'scored',
    alertable: false,
    measured: { focusKind: 'drowsiness', glanceS: 0, speedMps: 0 },
  });
});

test('q comes from the camera; below 0.5 the event is only possible', () => {
  expect(only(make().push(row(), L, glance(3, { q: 0.4 })))).toMatchObject({
    q: 0.4,
    status: 'possible',
    alertable: false,
  });
});

test('corrected follows the camera pipeline’s grace judgement', () => {
  expect(only(make().push(row(), L, glance(3, { correctedWithinGrace: true })))).toMatchObject({
    corrected: true,
  });
  expect(only(make().push(row(), L, glance(3, { correctedWithinGrace: false })))).toMatchObject({
    corrected: false,
  });
});

test('context is the row’s and flush has nothing to close', () => {
  const det = make();
  const e = only(det.push(row(), L, { ...glance(3), night: true, precipitation: true }));
  expect(e.context).toEqual({ night: true, precipitation: true });
  expect(det.flush()).toEqual([]);
});
