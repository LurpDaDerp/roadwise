/** @jest-environment node */
// The runtime controller's published states, which the root layout renders from: a first launch,
// a handover's rebuild (the switching-accounts screen until the new launch lands) and a retry.
import type { AppRuntime, ForegroundJobs } from '@/boot/bootstrap';
import { createRuntimeController, type RuntimeState } from '@/boot/controller';

// The boot is a stub per launch; the real one (and everything it loads) is not needed.
jest.mock('@/boot/bootstrap', () => ({ bootstrapApp: jest.fn(), startForegroundJobs: jest.fn() }));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const runtime = (name: string) => ({ name, stop: jest.fn(async () => {}) }) as unknown as AppRuntime;
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setup() {
  const launches: Deferred<AppRuntime>[] = [];
  const seen: Pick<RuntimeState, 'status' | 'runtime' | 'error'>[] = [];
  const controller = createRuntimeController({
    appState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    bootstrap: () => {
      const d = deferred<AppRuntime>();
      launches.push(d);
      return d.promise;
    },
    startForegroundJobs: async () => ({ stop: async () => {}, runNow: async () => true }) as unknown as ForegroundJobs,
    onError: () => {},
  });
  controller.subscribe((s) => void seen.push({ status: s.status, runtime: s.runtime, error: s.error }));
  return { controller, launches, seen, statuses: () => seen.map((s) => s.status) };
}

test('a first launch: booting, then ready', async () => {
  const { controller, launches, statuses } = setup();
  const a = runtime('a');
  const ready = controller.ensureRuntime('foreground');
  launches[0]!.resolve(a);
  await expect(ready).resolves.toBe(a);
  expect(statuses()).toEqual(['booting', 'ready']);
});

test('a handover stays switching through the new launch (its wipe) until it lands; it never shows a bare booting', async () => {
  const { controller, launches, seen, statuses } = setup();
  const a = runtime('a');
  const first = controller.ensureRuntime('foreground');
  launches[0]!.resolve(a);
  await first;
  seen.length = 0;

  const b = runtime('b');
  const next = controller.rebuild({ expectedUid: 'user-b' });
  await tick();
  expect(a.stop).toHaveBeenCalledTimes(1);
  expect(launches).toHaveLength(2);
  // The new launch is still booting: the screen still says the phone is being set up.
  expect(controller.state()).toMatchObject({ status: 'switching', runtime: null, error: null });
  launches[1]!.resolve(b);
  await expect(next).resolves.toBe(b);
  expect(statuses()).toEqual(['switching', 'switching', 'ready']);
  expect(seen.at(-1)).toMatchObject({ runtime: b, error: null });
});

test('a handover whose launch fails shows the failure; its Retry shows "retrying" with that error, as any retry', async () => {
  const { controller, launches, seen, statuses } = setup();
  const first = controller.ensureRuntime('foreground');
  launches[0]!.resolve(runtime('a'));
  await first;
  seen.length = 0;

  const failure = new Error('disk');
  const next = controller.rebuild({ expectedUid: 'user-b' });
  await tick();
  launches[1]!.reject(failure);
  await expect(next).rejects.toBe(failure);
  expect(statuses()).toEqual(['switching', 'switching', 'failed']);
  expect(seen.at(-1)).toMatchObject({ runtime: null, error: failure });

  const c = runtime('c');
  const retry = controller.ensureRuntime();
  expect(controller.state()).toMatchObject({ status: 'booting', runtime: null, error: failure });
  launches[2]!.resolve(c);
  await expect(retry).resolves.toBe(c);
  expect(statuses().slice(3)).toEqual(['booting', 'ready']);
});
