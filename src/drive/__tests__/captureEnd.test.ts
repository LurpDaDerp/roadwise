// What native takes from a drive's end at stopCapture: an automatic end says so (iOS), so the detector's linger watches on.
import { createSession } from '@/core/engine/session';
import { captureEndOf, isAutomaticEnd } from '@/drive/host';

const T0 = 1_700_000_000_000;
const closed = { ...createSession({ clientTripId: 'a', startedAt: T0, origin: 'auto' }), endedAt: T0 + 60_000 };

test('an automatic end is marked; a kept drive keeps its driving end, one not kept has none', () => {
  expect(captureEndOf(closed, T0 + 70_000, true, true)).toEqual({ drivingEndedAt: T0 + 60_000, drivingAtEnd: false, automatic: true });
  expect(captureEndOf(closed, T0 + 70_000, true)).toEqual({ drivingEndedAt: T0 + 60_000, drivingAtEnd: false });
  expect(captureEndOf(closed, T0 + 70_000, false, true)).toEqual({ drivingEndedAt: null, drivingAtEnd: false, automatic: true });
});

test('the still, parking-spot, car-link, walking, step and 12 h ends are automatic; manual and orphan ends are not', () => {
  for (const c of ['stopped', 'walking', 'limit'] as const) expect(isAutomaticEnd(c)).toBe(true);
  for (const c of ['manual', 'orphan', null] as const) expect(isAutomaticEnd(c)).toBe(false);
});
