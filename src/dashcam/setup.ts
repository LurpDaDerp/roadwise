// Setting up a DashPal (plan §7.9): only on the driver's explicit action, never while a drive is
// open. Find dashcams in pairing mode (the `00f0` service) for up to 15 s, strongest signal first
// (RSSI ≥ −80); connect (Android: a stale OS bond is dropped before connecting), read INFO (open),
// make the candidate beep (IDENTIFY), and ask "Is your DashPal beeping?". Yes: bond on that same
// connection (Android: createBond, ≤ 60 s; iOS: an encrypted TX read raises the system pairing
// dialog), subscribe, COMMAND 7 hello, COMMAND 5
// (pair confirm), save the pairing, and hand the dashcam to the auto-connect. No: the next one, or
// "press its button 5 times". UI-free: the screen renders `phase` and calls `answer`/`cancel`.
import type { BluetoothAccess } from '@/core/permissions/adapters';

import { encodeRx, COMMAND, PAIRING_SERVICE, speaksV1, decodeTx, type DashcamInfo } from './protocol';
import type { PairedDashcam } from './keys';
import { isBondLoss, type DashcamTransport, type ScanHit } from './transport';

export const SCAN_SECONDS = 15;
/** Stop listening this long after the first candidate (the closest is usually first). */
export const SCAN_SETTLE_MS = 4000;
export const MIN_RSSI = -80;
/** Waiting for PAIRED after COMMAND 5. */
export const PAIRED_WAIT_MS = 3000;

export interface Candidate {
  id: string;
  name: string | null;
  rssi: number;
}

export type SetupPhase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'permission' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'unavailable' }
  | { kind: 'scanning' }
  | { kind: 'connecting'; candidate: Candidate }
  | { kind: 'confirm'; candidate: Candidate; info: DashcamInfo }
  | { kind: 'bonding'; candidate: Candidate; info: DashcamInfo }
  | { kind: 'finishing'; candidate: Candidate; info: DashcamInfo }
  | { kind: 'none_found' }
  | { kind: 'done'; paired: PairedDashcam }
  | { kind: 'failed'; reason: 'error' | 'ios_forget_first' }
  | { kind: 'cancelled' };

export interface SetupDeps {
  platform: 'ios' | 'android';
  transport: () => DashcamTransport | null;
  /** The permissions adapter's DashPal request (the driver tapped). */
  requestBluetooth(): Promise<BluetoothAccess>;
  /** The drive host is busy (a drive open or closing). */
  isBusy(): boolean;
  /** Record the opt-in (settings + the launch flag). */
  optIn(): Promise<void>;
  /** Save the pairing and hand it to the auto-connect. */
  pair(record: PairedDashcam): Promise<void>;
  /** The currently paired dashcam (re-pairing replaces it). */
  paired(): PairedDashcam | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Prefer this peripheral (the auto prompt found it). */
  preferId?: string;
  onError?(e: unknown, ctx: string): void;
}

export interface SetupFlow {
  phase(): SetupPhase;
  subscribe(fn: (p: SetupPhase) => void): () => void;
  start(): Promise<void>;
  /** The driver's answer to "Is your DashPal beeping?". */
  answer(yes: boolean): void;
  cancel(): Promise<void>;
}

export function createSetupFlow(deps: SetupDeps): SetupFlow {
  let phase: SetupPhase = { kind: 'idle' };
  const listeners = new Set<(p: SetupPhase) => void>();
  let cancelled = false;
  let answerWaiter: ((yes: boolean) => void) | null = null;
  let current: string | null = null;
  let stopScan: (() => Promise<void>) | null = null;
  let running = false;

  function report(e: unknown, ctx: string): void {
    try {
      deps.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  }

  function set(next: SetupPhase): void {
    phase = next;
    for (const fn of [...listeners]) {
      try {
        fn(next);
      } catch (e) {
        report(e, 'listener');
      }
    }
  }

  async function release(t: DashcamTransport, id: string | null): Promise<void> {
    if (id === null) return;
    await t.disconnect(id).catch((e: unknown) => report(e, 'disconnect'));
    if (current === id) current = null;
  }

  async function scan(t: DashcamTransport): Promise<Candidate[]> {
    const found = new Map<string, Candidate>();
    let firstAt: number | null = null;
    const session = await t.scan({
      service: PAIRING_SERVICE,
      seconds: SCAN_SECONDS,
      onHit: (hit: ScanHit) => {
        if (hit.rssi < MIN_RSSI || !hit.pairing) return;
        const prev = found.get(hit.id);
        if (!prev || hit.rssi > prev.rssi) found.set(hit.id, { id: hit.id, name: hit.name, rssi: hit.rssi });
        firstAt ??= deps.now();
      },
    });
    stopScan = session.stop;
    const started = deps.now();
    while (!cancelled) {
      const at = deps.now();
      if (at - started >= SCAN_SECONDS * 1000) break;
      if (firstAt !== null && at - firstAt >= SCAN_SETTLE_MS) break;
      await deps.sleep(250);
    }
    await session.stop();
    stopScan = null;
    const list = [...found.values()].sort((a, b) => b.rssi - a.rssi);
    const preferred = deps.preferId ? list.findIndex((c) => c.id === deps.preferId) : -1;
    if (preferred > 0) list.unshift(...list.splice(preferred, 1));
    return list;
  }

  function waitAnswer(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      answerWaiter = resolve;
    });
  }

  /** Bond, subscribe, hello, pair confirm, save. */
  async function finish(t: DashcamTransport, c: Candidate, info: DashcamInfo): Promise<'done' | 'ios_forget_first' | 'error'> {
    set({ kind: 'bonding', candidate: c, info });
    try {
      await t.bond(c.id);
    } catch (e) {
      report(e, 'bond');
      return deps.platform === 'ios' && isBondLoss(e, 'ios') ? 'ios_forget_first' : 'error';
    }
    if (cancelled) return 'error';
    set({ kind: 'finishing', candidate: c, info });
    let paired = false;
    const unsubscribe = await t.subscribe(c.id, (bytes) => {
      const d = decodeTx(bytes);
      if (d.ok && d.frame.type === 'PAIRED') paired = true;
    });
    try {
      await t.writeTo(c.id, encodeRx({ type: 'COMMAND', op: COMMAND.HELLO, arg: 0 }));
      await t.writeTo(c.id, encodeRx({ type: 'COMMAND', op: COMMAND.PAIR_CONFIRM, arg: 0 }));
      const until = deps.now() + PAIRED_WAIT_MS;
      while (!paired && !cancelled && deps.now() < until) await deps.sleep(100);
    } finally {
      unsubscribe();
    }
    if (cancelled) return 'error';
    const record: PairedDashcam = { dashcamId: info.dashcamId, peripheralId: c.id, name: info.name, pairedAt: deps.now() };
    // The setup connection goes; the auto-connect takes the dashcam back on its own (bonded now).
    await release(t, c.id);
    await deps.pair(record);
    set({ kind: 'done', paired: record });
    return 'done';
  }

  const flow: SetupFlow = {
    phase: () => phase,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    async start() {
      if (running) return;
      running = true;
      cancelled = false;
      try {
        if (deps.isBusy()) {
          set({ kind: 'busy' });
          return;
        }
        set({ kind: 'permission' });
        await deps.optIn().catch((e: unknown) => report(e, 'optIn'));
        const access = await deps.requestBluetooth().catch((e: unknown) => {
          report(e, 'requestBluetooth');
          return 'undetermined' as const;
        });
        if (cancelled) return;
        if (access === 'denied' || access === 'undetermined') return set({ kind: 'denied' });
        if (access === 'off') return set({ kind: 'off' });
        if (access === 'unavailable') return set({ kind: 'unavailable' });
        const t = deps.transport();
        if (!t) return set({ kind: 'unavailable' });

        // The paired dashcam's auto-connect steps aside while setup runs (re-pairing it, or
        // replacing it); a failed setup gives it back.
        const before = deps.paired();
        if (before) t.setTarget(null);
        let result: 'done' | 'ios_forget_first' | 'error' | 'none' = 'none';
        try {
          set({ kind: 'scanning' });
          const candidates = await scan(t);
          for (const c of candidates) {
            if (cancelled || deps.isBusy()) break;
            set({ kind: 'connecting', candidate: c });
            current = c.id;
            let info: DashcamInfo | null = null;
            try {
              await t.setupConnect(c.id);
              info = await t.readInfo(c.id);
              if (!info || !speaksV1(info)) throw new Error('not a DashPal this app can pair');
              await t.identify(c.id);
            } catch (e) {
              report(e, 'connect');
              await release(t, c.id);
              continue;
            }
            set({ kind: 'confirm', candidate: c, info });
            const yes = await waitAnswer();
            if (cancelled) break;
            if (!yes) {
              await release(t, c.id);
              continue;
            }
            result = await finish(t, c, info);
            if (result !== 'done') await release(t, c.id);
            break;
          }
        } catch (e) {
          report(e, 'setup');
          result = 'error';
        } finally {
          if (result !== 'done' && before) t.setTarget({ peripheralId: before.peripheralId, dashcamId: before.dashcamId });
        }
        if (cancelled) return set({ kind: 'cancelled' });
        if (result === 'none') set({ kind: 'none_found' });
        else if (result === 'ios_forget_first') set({ kind: 'failed', reason: 'ios_forget_first' });
        else if (result === 'error') set({ kind: 'failed', reason: 'error' });
      } finally {
        running = false;
      }
    },

    answer(yes) {
      const w = answerWaiter;
      answerWaiter = null;
      w?.(yes);
    },

    async cancel() {
      cancelled = true;
      flow.answer(false);
      const stop = stopScan;
      stopScan = null;
      await stop?.().catch((e: unknown) => report(e, 'stopScan'));
      const t = deps.transport();
      if (t && current) await release(t, current);
      if (!running) set({ kind: 'cancelled' });
    },
  };
  return flow;
}
