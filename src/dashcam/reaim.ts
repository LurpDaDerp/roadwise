// The re-aim flow (docs/BLE_PROTOCOL.md §3.5): the paired DashPal's live picture outside setup, so
// the driver can aim its camera again from Settings › DashPal (firmware 3.6). It asks the dashcam
// for the aiming stream over the paired link (COMMAND 10), reassembles the VIEW records the
// transport opens under the paired session (`view.ts`) and hands the images and AIM frames to the
// sheet's `AimView`. Nothing here stores, logs or reports a record or an image: they go to the
// listeners only, and every open image is zeroed when the stream starts again or stops.
//
// Done stops the stream (COMMAND 10 arg 0), and the dashcam recalibrates and clears its re-aim
// flag. When no picture ever came (a refusal, firmware before 3.6), Done sends COMMAND 2 instead,
// so the Recalibrate row always recalibrates. The timings are the setup's (`setup.ts`).
import type { DashcamLink } from './link';
import { AIM_ARG, COMMAND, viewReason, type AimFrame, type ViewReason } from './protocol';
import type { DashcamTransport } from './transport';
import { createViewAssembler } from './view';

/** No image this long after the start, or this long after the last one: stalled (the start sent again, every `REAIM_STALL_MS`). */
export const REAIM_FIRST_MS = 4000;
export const REAIM_STALL_MS = 3000;
/** Stalled this long: refused as `camera`. */
export const REAIM_GIVE_UP_MS = 15_000;
/** How often the flow looks at its picture. */
export const REAIM_TICK_MS = 250;
/** The firmware that streams to a paired phone (`dms-core 3.6`). */
export const REAIM_MIN_FIRMWARE: readonly [number, number] = [3, 6];
/** The refusals Try again can help with (mtu cannot change; the others can, once the car stops or a moment later). */
export const REAIM_RETRY: readonly ViewReason[] = ['moving', 'drive', 'budget', 'busy', 'camera', 'memory', 'no_state', 'not_allowed', 'hold_ended', 'ok'];

/** idle: not started; offline: no link to the DashPal; unsupported: firmware before 3.6. */
export type ReaimStatus = 'idle' | 'offline' | 'unsupported' | 'starting' | 'live' | 'stalled' | 'refused';

export interface ReaimPhase {
  status: ReaimStatus;
  reason: ViewReason | null;
}

export interface ReaimDeps {
  link: Pick<DashcamLink, 'command' | 'onViewFrames' | 'snapshot'>;
  transport(): Pick<DashcamTransport, 'subscribePairedView' | 'unsubscribePairedView'> | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  onError?(e: unknown, ctx: string): void;
}

export interface ReaimFlow {
  phase(): ReaimPhase;
  onPhase(fn: (p: ReaimPhase) => void): () => void;
  /** Start, or Try again on a refusal. */
  start(): Promise<void>;
  /** Done (or the sheet closed): the stream stops; COMMAND 2 when no picture ever came. Final. */
  close(): Promise<void>;
  /** RoadWise in the front or not: leaving stops the picture, coming back starts it again. */
  setAppActive(active: boolean): void;
  /** The images (JPEG bytes, in memory only), while the picture runs. */
  onViewFrame(fn: (jpeg: Uint8Array) => void): () => void;
  /** The AIM frames; null when the picture stops (no reading). */
  onAim(fn: (a: AimFrame | null) => void): () => void;
  /** A picture was on at some point. */
  streamed(): boolean;
}

/** Whether `dms-core x.y` streams to a paired phone: null when the version is unknown. */
export function supportsReaim(firmware: string | null): boolean | null {
  const m = firmware ? /^dms-core (\d+)\.(\d+)$/.exec(firmware) : null;
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > REAIM_MIN_FIRMWARE[0] || (major === REAIM_MIN_FIRMWARE[0] && minor >= REAIM_MIN_FIRMWARE[1]);
}

export function createReaimFlow(deps: ReaimDeps): ReaimFlow {
  const report = (e: unknown, ctx: string) => deps.onError?.(e, `reaim ${ctx}`);
  const assembler = createViewAssembler();
  const phaseListeners = new Set<(p: ReaimPhase) => void>();
  const frameListeners = new Set<(jpeg: Uint8Array) => void>();
  const aimListeners = new Set<(a: AimFrame | null) => void>();
  let phase: ReaimPhase = { status: 'idle', reason: null };
  let closed = false;
  let appActive = true;
  let resume = false;
  /** the picture is wanted (asked and not stopped) */
  let wanted = false;
  let streamOn = false;
  let everOn = false;
  let refusal: ViewReason | null = null;
  let startedAt = 0;
  let lastImageAt: number | null = null;
  let stalledAt: number | null = null;
  let lastStartAt = 0;
  let timer: unknown = null;
  let io: Promise<void> = Promise.resolve();
  let gen = 0;

  function set(next: ReaimPhase): void {
    if (next.status === phase.status && next.reason === phase.reason) return;
    phase = next;
    for (const fn of [...phaseListeners]) {
      try {
        fn(phase);
      } catch (e) {
        report(e, 'phase listener');
      }
    }
  }

  function emitAim(a: AimFrame | null): void {
    for (const fn of [...aimListeners]) {
      try {
        fn(a);
      } catch (e) {
        report(e, 'aim listener');
      }
    }
  }

  function onRecord(rec: number[]): void {
    if (!wanted) return;
    const r = assembler.put(rec);
    for (const f of r.acks) void deps.link.command(COMMAND.VIEW_ACK, f, { withResponse: false }).catch((e: unknown) => report(e, 'view ack'));
    if (!r.image) return;
    lastImageAt = deps.now();
    for (const fn of [...frameListeners]) {
      try {
        fn(r.image.jpeg);
      } catch (e) {
        report(e, 'view listener');
      }
    }
  }

  const offFrames = deps.link.onViewFrames((f) => {
    if (!wanted) return;
    if (f.type === 'AIM') {
      emitAim(f);
      return;
    }
    streamOn = f.on === 1;
    if (streamOn) everOn = true;
    else if (f.reason !== 0) refusal = viewReason(f.reason);
  });

  /** The BLE steps run in the order asked, never two at once. */
  function step(run: () => Promise<void>): Promise<void> {
    const p = io.then(run);
    io = p.catch((e: unknown) => report(e, 'step'));
    return io;
  }

  function linked(): boolean {
    return deps.link.snapshot().lifecycle === 'connected';
  }

  async function askStart(): Promise<void> {
    if (!wanted || !appActive) return;
    if (!streamOn) assembler.start();
    lastStartAt = deps.now();
    await deps.link.command(COMMAND.AIM, AIM_ARG.START).catch((e: unknown) => {
      report(e, 'start');
      return false;
    });
  }

  /** The picture stops: no reading and the open images zeroed at once; then COMMAND 10 arg 0 (`send`) and VIEW off. */
  async function stop(o: { send: boolean }): Promise<void> {
    if (!wanted) return;
    wanted = false;
    streamOn = false;
    lastImageAt = null;
    assembler.wipe();
    emitAim(null);
    ++gen;
    await step(async () => {
      if (o.send && linked()) await deps.link.command(COMMAND.AIM, AIM_ARG.STOP).catch((e: unknown) => report(e, 'stop'));
      await deps.transport()?.unsubscribePairedView().catch((e: unknown) => report(e, 'unsubscribe'));
    });
  }

  function arm(): void {
    if (timer !== null || closed) return;
    timer = deps.setTimer(() => {
      timer = null;
      void watch().finally(() => {
        if (wanted) arm();
      });
    }, REAIM_TICK_MS);
  }

  /** One look: the link gone, a refusal, the first image, a stall (start again), giving up. */
  async function watch(): Promise<void> {
    if (!wanted) return;
    const now = deps.now();
    if (!linked()) {
      await stop({ send: false });
      set({ status: 'offline', reason: null });
      return;
    }
    if (refusal) {
      const reason = refusal;
      await stop({ send: false });
      set({ status: 'refused', reason });
      return;
    }
    const since = lastImageAt ?? startedAt;
    if (phase.status === 'stalled' && stalledAt !== null && lastImageAt !== null && lastImageAt > stalledAt) {
      stalledAt = null;
      set({ status: 'live', reason: null });
    } else if (phase.status === 'starting' && lastImageAt !== null) set({ status: 'live', reason: null });
    else if (phase.status !== 'stalled' && now - since >= (lastImageAt === null ? REAIM_FIRST_MS : REAIM_STALL_MS)) {
      stalledAt = now;
      set({ status: 'stalled', reason: null });
      await askStart();
    } else if (phase.status === 'stalled' && stalledAt !== null) {
      if (now - stalledAt >= REAIM_GIVE_UP_MS) {
        await stop({ send: true });
        set({ status: 'refused', reason: 'camera' });
      } else if (now - lastStartAt >= REAIM_STALL_MS) await askStart();
    }
  }

  async function start(): Promise<void> {
    if (closed || wanted) return;
    if (!linked()) {
      set({ status: 'offline', reason: null });
      return;
    }
    if (supportsReaim(deps.link.snapshot().firmware) === false) {
      set({ status: 'unsupported', reason: null });
      return;
    }
    const t = deps.transport();
    if (!t) {
      set({ status: 'offline', reason: null });
      return;
    }
    if (!appActive) {
      resume = true;
      return;
    }
    refusal = null;
    lastImageAt = null;
    stalledAt = null;
    streamOn = false;
    startedAt = deps.now();
    wanted = true;
    set({ status: 'starting', reason: null });
    const g = ++gen;
    await step(async () => {
      if (g !== gen) return;
      try {
        await t.subscribePairedView(onRecord);
      } catch (e) {
        report(e, 'subscribe');
      }
      if (g === gen) await askStart();
    });
    arm();
  }

  return {
    phase: () => phase,

    onPhase(fn) {
      phaseListeners.add(fn);
      return () => {
        phaseListeners.delete(fn);
      };
    },

    start,

    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      await stop({ send: true });
      offFrames();
      // no picture ever came: the Recalibrate row still recalibrates (a stream's stop does it on the dashcam)
      if (!everOn && linked()) await deps.link.command(COMMAND.RECALIBRATE, 0).catch((e: unknown) => report(e, 'recalibrate'));
    },

    setAppActive(active) {
      appActive = active;
      if (!active) {
        if (!wanted) return;
        resume = true;
        void stop({ send: true }).then(() => set({ status: 'starting', reason: null }));
        return;
      }
      if (resume) {
        resume = false;
        void start();
      }
    },

    onViewFrame(fn) {
      frameListeners.add(fn);
      return () => {
        frameListeners.delete(fn);
      };
    },

    onAim(fn) {
      aimListeners.add(fn);
      return () => {
        aimListeners.delete(fn);
      };
    },

    streamed: () => everOn,
  };
}
