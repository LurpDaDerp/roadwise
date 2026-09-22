/**
 * The one runtime of this process, and its lifecycle (plan H2).
 *
 * Three callers want the runtime, and they must share one:
 *   - `index.ts` boots it eagerly at module load, so a background launch (an iOS location wake, an
 *     iOS relaunch mid-drive) starts the drive engine without waiting for React to mount anything;
 *   - the Android headless task (`./headless.ts`) asks for it as `'background'`;
 *   - the root layout renders from it.
 * `ensureRuntime` memoises the launch per **generation**: the first caller's profile is the
 * launch's, and everyone after gets the same promise.
 *
 * `rebuild()` starts the next generation — a handover (another driver signed in): it awaits the
 * old runtime's teardown (its foreground jobs, then `stop()`, which ends an open drive) before the
 * new launch begins, so two runtimes never hold the database, the native module or the queue at
 * once, and the new launch's `identity` stage is what wipes the device.
 *
 * **Foreground jobs** (hydration, the config fetch, the tile purge) are started only on the
 * foreground path: at once when the app is active when the runtime lands, otherwise on the first
 * transition to `active` — never by a background wake or the headless task (plan rev1: I3, D1). A
 * background launch the driver then opens gets them on that transition, with no rebuild.
 */
import { AppState } from 'react-native';

import {
  bootstrapApp,
  startForegroundJobs,
  type AppRuntime,
  type ForegroundJobs,
} from './bootstrap';
import { launchProfile, type LaunchProfile } from './launchProfile';

export interface RuntimeState {
  /**
   * `booting` — a launch is in flight (`error` carries the last failure while a retry runs);
   * `ready` — `runtime` is live; `failed` — the last launch failed, `error` says why;
   * `switching` — a handover's rebuild is tearing the old runtime down.
   */
  status: 'booting' | 'ready' | 'failed' | 'switching';
  runtime: AppRuntime | null;
  error: Error | null;
  generation: number;
}

export interface RuntimeController {
  /** The current generation's runtime, booting it (as `profile`, default from AppState) if needed. */
  ensureRuntime(profile?: LaunchProfile): Promise<AppRuntime>;
  /** Tear the current runtime down (awaited) and boot the next generation. */
  rebuild(): Promise<AppRuntime>;
  state(): RuntimeState;
  subscribe(fn: (state: RuntimeState) => void): () => void;
  /** The live runtime's foreground jobs, once started (U4's restore Retry calls `runNow`). */
  foregroundJobs(): ForegroundJobs | null;
}

export interface RuntimeControllerDeps {
  /** Default: React Native's `AppState`. */
  appState?: {
    currentState?: string | null;
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };
  /** Default: `bootstrapApp({ profile })` with the device adapters. */
  bootstrap?: (profile: LaunchProfile) => Promise<AppRuntime>;
  /** Default: `startForegroundJobs(runtime)`. */
  startForegroundJobs?: (runtime: AppRuntime) => Promise<ForegroundJobs>;
  onError?: (error: unknown, context: string) => void;
}

interface Generation {
  id: number;
  promise: Promise<AppRuntime>;
  /** Set on teardown: whatever lands later is stopped by that teardown, never published. */
  retired: boolean;
  jobs: Promise<ForegroundJobs | null> | null;
  jobsReady: ForegroundJobs | null;
  /** The wait for `active` (background launches only). */
  unlisten: (() => void) | null;
}

function warn(error: unknown, context: string): void {
  if (__DEV__) console.warn(`[runtime] ${context}:`, error);
}

const toError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(String(reason));

export function createRuntimeController(deps: RuntimeControllerDeps = {}): RuntimeController {
  const appState = deps.appState ?? AppState;
  const boot = deps.bootstrap ?? ((profile: LaunchProfile) => bootstrapApp({ profile }));
  const startJobs = deps.startForegroundJobs ?? ((runtime: AppRuntime) => startForegroundJobs(runtime));
  const onError = deps.onError ?? warn;

  let generation = 0;
  let current: Generation | null = null;
  let rebuilding: Promise<AppRuntime> | null = null;
  let state: RuntimeState = { status: 'booting', runtime: null, error: null, generation: 0 };
  const listeners = new Set<(state: RuntimeState) => void>();

  function publish(next: RuntimeState): void {
    state = next;
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (error) {
        onError(error, 'state listener');
      }
    }
  }

  /** Foreground jobs for `gen`: now if the app is active, else on its first `active`. */
  function startJobsWhenActive(gen: Generation, runtime: AppRuntime): void {
    const start = () => {
      if (gen.retired || gen.jobs) return;
      gen.unlisten?.();
      gen.unlisten = null;
      gen.jobs = startJobs(runtime).then(
        (jobs) => {
          gen.jobsReady = jobs;
          return jobs;
        },
        (error: unknown) => {
          onError(error, 'foreground jobs');
          return null;
        }
      );
    };
    if (appState.currentState === 'active') {
      start();
      return;
    }
    const subscription = appState.addEventListener('change', (next) => {
      if (next === 'active') start();
    });
    gen.unlisten = () => subscription.remove();
  }

  function launch(profile: LaunchProfile): Generation {
    const gen: Generation = {
      id: generation,
      promise: Promise.resolve() as unknown as Promise<AppRuntime>,
      retired: false,
      jobs: null,
      jobsReady: null,
      unlisten: null,
    };
    // A retry keeps showing what failed, as "retrying", until it lands one way or the other.
    const carried = state.status === 'failed' ? state.error : null;
    publish({ status: 'booting', runtime: null, error: carried, generation: gen.id });
    gen.promise = boot(profile).then(
      (runtime) => {
        if (gen.retired) return runtime; // its teardown awaits this promise and stops it
        publish({ status: 'ready', runtime, error: null, generation: gen.id });
        startJobsWhenActive(gen, runtime);
        return runtime;
      },
      (reason: unknown) => {
        const error = toError(reason);
        if (current === gen) current = null; // the next call boots again: the layout's Retry
        if (!gen.retired) publish({ status: 'failed', runtime: null, error, generation: gen.id });
        throw error;
      }
    );
    return gen;
  }

  async function teardown(gen: Generation): Promise<void> {
    gen.retired = true;
    gen.unlisten?.();
    gen.unlisten = null;
    const runtime = await gen.promise.catch(() => null);
    const jobs = gen.jobs ? await gen.jobs : null;
    if (jobs) await jobs.stop().catch((error: unknown) => onError(error, 'stop foreground jobs'));
    // Ends an open drive (queued under the outgoing owner; the next launch's wipe removes it).
    if (runtime) await runtime.stop().catch((error: unknown) => onError(error, 'stop runtime'));
  }

  function ensureRuntime(profile?: LaunchProfile): Promise<AppRuntime> {
    if (rebuilding) return rebuilding;
    if (current) return current.promise;
    current = launch(profile ?? launchProfile(appState));
    return current.promise;
  }

  function rebuild(): Promise<AppRuntime> {
    if (rebuilding) return rebuilding;
    const run = (async () => {
      generation += 1;
      const old = current;
      current = null;
      publish({ status: 'switching', runtime: null, error: null, generation });
      if (old) await teardown(old);
      current = launch(launchProfile(appState));
      return current.promise;
    })();
    rebuilding = run;
    const clear = () => {
      if (rebuilding === run) rebuilding = null;
    };
    run.then(clear, clear);
    return run;
  }

  return {
    ensureRuntime,
    rebuild,
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    foregroundJobs: () => (current && !current.retired ? current.jobsReady : null),
  };
}

/** The process's controller. Nothing runs until the first `ensureRuntime`. */
export const runtimeController: RuntimeController = createRuntimeController();

export const ensureRuntime = (profile?: LaunchProfile): Promise<AppRuntime> =>
  runtimeController.ensureRuntime(profile);
export const rebuild = (): Promise<AppRuntime> => runtimeController.rebuild();
export const subscribe = (fn: (state: RuntimeState) => void): (() => void) =>
  runtimeController.subscribe(fn);
export const getRuntimeState = (): RuntimeState => runtimeController.state();
