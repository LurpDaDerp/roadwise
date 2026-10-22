import type { DriveState } from '@/drive/host';
import { selectBearing } from '@/drive/useDrive';

const state = (over: Partial<DriveState>) => ({ status: 'recording', courseDeg: 45, ...over }) as DriveState;

test("selectBearing hands the HUD the engine's bearing and its source, apart from the old GPS-course heading", () => {
  expect(selectBearing(state({ bearingDeg: 182.5, bearingSource: 'track' }))).toEqual({ deg: 182.5, source: 'track' });
  expect(selectBearing(state({ bearingDeg: null, bearingSource: null }))).toEqual({ deg: null, source: null });
  // A state from before the fields existed (a test double) reads as none.
  expect(selectBearing({ status: 'idle' } as DriveState)).toEqual({ deg: null, source: null });
});
