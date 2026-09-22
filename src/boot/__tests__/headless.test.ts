import {
  createDriveHeadlessTask,
  DRIVE_HEADLESS_TASK,
  HEADLESS_DRAIN_TIMEOUT_MS,
  INHERITED_CAPTURE_WAIT_MS,
  registerDriveHeadlessTask,
} from '@/boot/headless';
import { isHeadlessActive } from '@/boot/launchProfile';
import type { AppRuntime } from '@/boot/bootstrap';

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A runtime whose drive becomes idle, and whose drain answers, when the test says so. */
function scriptedRuntime() {
  const log: string[] = [];
  let idle: () => void = () => {};
  let drained: () => void = () => {};
  let runnerIdle: () => void = () => {};
  let capturing = false;
  const subscribers = new Set<() => void>();
  const runtime = {
    drive: {
      captureActive: () => capturing,
      subscribe: (fn: () => void) => {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      untilIdle: () =>
        new Promise<void>((resolve) => {
          log.push('untilIdle');
          idle = () => {
            log.push('idle');
            resolve();
          };
        }),
    },
    runner: {
      idle: () =>
        new Promise<void>((resolve) => {
          log.push('runner idle?');
          runnerIdle = () => {
            log.push('runner idle');
            resolve();
          };
        }),
      drainOnce: () =>
        new Promise((resolve) => {
          log.push(`drain (headless active: ${isHeadlessActive()})`);
          drained = () => resolve({ sent: 1 });
        }),
    },
  } as unknown as AppRuntime;
  return {
    runtime,
    log,
    idle: () => idle(),
    drained: () => drained(),
    runnerIdle: () => runnerIdle(),
    setCapturing(on: boolean) {
      capturing = on;
    },
    publish() {
      for (const fn of [...subscribers]) fn();
    },
    subscribers: () => subscribers.size,
  };
}

function deps(over: Partial<Parameters<typeof createDriveHeadlessTask>[0]> = {}) {
  const calls: string[] = [];
  const reports: string[] = [];
  const base = {
    ensureRuntime: jest.fn(async () => scriptedRuntime().runtime),
    stopCapture: jest.fn(async () => {
      calls.push('stopCapture');
    }),
    report: (error: unknown) => {
      reports.push(error instanceof Error ? error.message : String(error));
    },
    attachNotifier: jest.fn(() => ({ detach: () => calls.push('detach'), settled: async () => {} })),
    ...over,
  };
  return { deps: base, calls, reports };
}

describe('the DriveSenseTask body', () => {
  test('a boot that fails stops the capture it would otherwise orphan, and resolves', async () => {
    const { deps: d, calls, reports } = deps({
      ensureRuntime: jest.fn(async () => {
        throw new Error('bootstrap failed at migrate: SQLITE_CORRUPT');
      }),
    });
    const task = createDriveHeadlessTask(d);
    await expect(task({})).resolves.toBeUndefined();
    expect(d.ensureRuntime).toHaveBeenCalledWith('background');
    expect(calls).toEqual(['stopCapture']);
    expect(reports).toEqual(['bootstrap failed at migrate: SQLITE_CORRUPT']);
    expect(isHeadlessActive()).toBe(false);
  });

  test('a stopCapture that also fails still resolves (the native watchdog is the second line)', async () => {
    const { deps: d, reports } = deps({
      ensureRuntime: jest.fn(async () => {
        throw new Error('boom');
      }),
      stopCapture: jest.fn(async () => {
        throw new Error('no module');
      }),
    });
    await expect(createDriveHeadlessTask(d)({})).resolves.toBeUndefined();
    expect(reports).toEqual(['boom']);
  });

  test('success: settles only after the drive is finalized and one drain has answered', async () => {
    const script = scriptedRuntime();
    const { deps: d, calls } = deps({ ensureRuntime: jest.fn(async () => script.runtime) });
    let settled = false;
    const run = createDriveHeadlessTask(d)({}).then(() => {
      settled = true;
    });
    await flush();
    expect(script.log).toEqual(['untilIdle']);
    expect(isHeadlessActive()).toBe(true);
    expect(settled).toBe(false);

    script.idle();
    await flush();
    // A drain the finalize already woke is waited for first (m2), then one bounded pass of its own.
    expect(script.log).toEqual(['untilIdle', 'idle', 'runner idle?']);
    expect(settled).toBe(false);
    script.runnerIdle();
    await flush();
    // The upload runs from the service (§3.5): the drain policy sees the headless task.
    expect(script.log).toEqual(['untilIdle', 'idle', 'runner idle?', 'runner idle', 'drain (headless active: true)']);
    expect(settled).toBe(false);

    script.drained();
    await run;
    expect(settled).toBe(true);
    expect(isHeadlessActive()).toBe(false);
    expect(d.stopCapture).not.toHaveBeenCalled();
    // The summary notification is scheduled from here when the app is not open (U3).
    expect(d.attachNotifier).toHaveBeenCalledWith(script.runtime.drive);
    expect(calls).toEqual(['detach']);
  });

  test('a drain that never answers is bounded: the task settles after 60 s, capture untouched', async () => {
    jest.useFakeTimers();
    try {
      const script = scriptedRuntime();
      const { deps: d, reports } = deps({ ensureRuntime: jest.fn(async () => script.runtime) });
      let settled = false;
      const run = createDriveHeadlessTask(d)({}).then(() => {
        settled = true;
      });
      await flush();
      script.idle();
      await flush();
      script.runnerIdle();
      await flush();
      expect(HEADLESS_DRAIN_TIMEOUT_MS).toBe(60_000);
      jest.advanceTimersByTime(59_999);
      await flush();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await run;
      expect(settled).toBe(true);
      // A slow upload is not a failed boot: the drive is already finalized, and a capture that may
      // have started since is left alone.
      expect(d.stopCapture).not.toHaveBeenCalled();
      expect(reports).toEqual(['headless drain did not answer within 60000 ms']);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('stopCapture only for a boot that failed (H2 r1 m1)', () => {
  test('an error after the runtime booted is reported, and never stops a live drive', async () => {
    const script = scriptedRuntime();
    (script.runtime.drive as unknown as { untilIdle: () => Promise<void> }).untilIdle = async () => {
      throw new Error('the host went wrong mid-drive');
    };
    const { deps: d, reports } = deps({ ensureRuntime: jest.fn(async () => script.runtime) });
    await expect(createDriveHeadlessTask(d)({})).resolves.toBeUndefined();
    expect(d.stopCapture).not.toHaveBeenCalled();
    expect(reports).toEqual(['the host went wrong mid-drive']);
    expect(isHeadlessActive()).toBe(false);
  });
});

describe('a capture native started before its wake arrived', () => {
  test('an idle host still holding the inherited capture waits for the wake, then for the drive', async () => {
    const script = scriptedRuntime();
    script.setCapturing(true);
    const { deps: d } = deps({ ensureRuntime: jest.fn(async () => script.runtime) });
    let settled = false;
    const run = createDriveHeadlessTask(d)({}).then(() => {
      settled = true;
    });
    await flush();
    script.idle(); // the first look: armed, capture running, the wake not delivered yet
    await flush();
    expect(script.log).toEqual(['untilIdle', 'idle']);
    expect(script.subscribers()).toBe(1);

    script.publish(); // the wake opened a candidate
    await flush();
    expect(script.log).toEqual(['untilIdle', 'idle', 'untilIdle']);
    expect(script.subscribers()).toBe(0);

    script.setCapturing(false);
    script.idle(); // the drive ended and was finalized
    await flush();
    script.runnerIdle();
    await flush();
    script.drained();
    await run;
    expect(settled).toBe(true);
  });

  test('the wait is bounded by the claim window: a wake that never comes costs 65 s, not the 6 h', async () => {
    jest.useFakeTimers();
    try {
      const script = scriptedRuntime();
      script.setCapturing(true);
      const { deps: d } = deps({ ensureRuntime: jest.fn(async () => script.runtime) });
      const run = createDriveHeadlessTask(d)({});
      await flush();
      script.idle();
      await flush();
      expect(INHERITED_CAPTURE_WAIT_MS).toBe(65_000);
      jest.advanceTimersByTime(INHERITED_CAPTURE_WAIT_MS);
      await flush();
      script.idle();
      await flush();
      script.runnerIdle();
      await flush();
      script.drained();
      await run;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('registerDriveHeadlessTask', () => {
  test('Android registers exactly DriveSenseTask', () => {
    const registerHeadlessTask = jest.fn();
    expect(DRIVE_HEADLESS_TASK).toBe('DriveSenseTask');
    expect(registerDriveHeadlessTask({ os: 'android', registry: { registerHeadlessTask } })).toBe(true);
    expect(registerHeadlessTask).toHaveBeenCalledTimes(1);
    expect(registerHeadlessTask.mock.calls[0]?.[0]).toBe('DriveSenseTask');
    const provider = registerHeadlessTask.mock.calls[0]?.[1] as () => unknown;
    expect(typeof provider()).toBe('function');
  });

  test('iOS registers nothing (it has no headless JS; a relaunch boots the app itself)', () => {
    const registerHeadlessTask = jest.fn();
    expect(registerDriveHeadlessTask({ os: 'ios', registry: { registerHeadlessTask } })).toBe(false);
    expect(registerHeadlessTask).not.toHaveBeenCalled();
  });
});
