/** @jest-environment node */
// The Android headless task when its boot fails (the task's other paths run against a real boot
// in bootstrap.test.ts).
import { createDriveHeadlessTask, type DriveHeadlessTaskDeps } from '@/boot/headless';
import { isHeadlessActive } from '@/boot/launchProfile';

// The task body is given its boot; the process's controller (and the whole boot behind it) is not needed.
jest.mock('@/boot/controller', () => ({ ensureRuntime: jest.fn() }));

function run(detectorRecording?: DriveHeadlessTaskDeps['detectorRecording']) {
  const failure = new Error('bootstrap timed out');
  const stopped: string[] = [];
  const reported: unknown[] = [];
  const task = createDriveHeadlessTask({
    ensureRuntime: async () => Promise.reject(failure),
    stopCapture: async () => void stopped.push('stop'),
    report: (e) => void reported.push(e),
    ...(detectorRecording ? { detectorRecording } : {}),
  });
  return { failure, stopped, reported, task };
}

describe('a boot that fails', () => {
  test("never stops a drive the detector records: native's own, it records on and the next good boot takes it in", async () => {
    const { failure, stopped, reported, task } = run(async () => true);
    await task({});
    expect(stopped).toEqual([]);
    expect(reported).toEqual([failure]);
    expect(isHeadlessActive()).toBe(false);
  });

  test('stops a plain capture (nobody would record it otherwise), with no detector or one not recording', async () => {
    for (const read of [undefined, async () => false]) {
      const { failure, stopped, reported, task } = run(read);
      await task({});
      expect(stopped).toEqual(['stop']);
      expect(reported).toEqual([failure]);
    }
    expect(isHeadlessActive()).toBe(false);
  });

  test("an unreadable detector state stops the capture, and the boot's error is still the one reported", async () => {
    const { failure, stopped, reported, task } = run(async () => Promise.reject(new Error('E_STATE')));
    await task({});
    expect(stopped).toEqual(['stop']);
    expect(reported).toEqual([failure]);
  });
});
