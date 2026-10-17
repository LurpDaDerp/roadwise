// The DashPal auto prompt (plan §1.4, §7.9): after the driver opted in, a dashcam in pairing mode
// nearby is offered for setup — never while driving, never with a permission prompt.
//
// A 10 s scan for the pairing service when the app comes to the foreground or the route changes to
// a tab, at most once per 2 minutes, and only when: opted in; Bluetooth already allowed (read, never
// asked); no drive open; not on the drive route; a speed probe under 3 mph (unknown speed blocks);
// no setup running; no paired dashcam connected (it suppresses detecting others). A found dashcam
// that the driver snoozed ("Not now", 7 days) is not offered. The prompt is dropped when a drive
// starts. Pure apart from its injected reads.
import type { ScanHit } from './transport';

export const DETECT_SCAN_SECONDS = 10;
export const DETECT_EVERY_MS = 2 * 60_000;
export const DETECT_MAX_MPH = 3;
export const DETECT_MIN_RSSI = -80;
export const SNOOZE_MS = 7 * 24 * 60 * 60_000;

export interface Found {
  id: string;
  name: string;
  rssi: number;
}

export interface DetectorDeps {
  now(): number;
  btOptIn(): boolean;
  /** Bluetooth already allowed and on (a read: never a prompt). */
  bluetoothReady(): Promise<boolean>;
  isBusy(): boolean;
  onDriveRoute(): boolean;
  /** mph, or null when unknown */
  speedMph(): Promise<number | null>;
  setupRunning(): boolean;
  pairedPeripheralId(): string | null;
  pairedConnected(): boolean;
  /** `{ [peripheralId]: snoozedUntilMs }` */
  snoozes(): Promise<Record<string, number>>;
  scan(opts: { seconds: number; onHit(hit: ScanHit): void }): Promise<{ stop(): Promise<void> }>;
  sleep(ms: number): Promise<void>;
  onError?(e: unknown, ctx: string): void;
}

export type DetectOutcome = { kind: 'found'; found: Found } | { kind: 'skipped'; why: string } | { kind: 'none' };

export interface Detector {
  /** Run the gates and maybe one scan. */
  check(): Promise<DetectOutcome>;
  /** Stop a scan in progress (a drive started, the app left the foreground). */
  abort(): Promise<void>;
}

export function createDetector(deps: DetectorDeps): Detector {
  let lastScanAt: number | null = null;
  let running = false;
  let aborted = false;
  let stop: (() => Promise<void>) | null = null;

  /** The gates that need no I/O, re-checked after every wait. */
  function blocked(): string | null {
    if (!deps.btOptIn()) return 'not opted in';
    if (deps.isBusy()) return 'drive open';
    if (deps.onDriveRoute()) return 'drive route';
    if (deps.setupRunning()) return 'setup running';
    if (deps.pairedConnected()) return 'paired dashcam connected';
    return null;
  }

  return {
    async check() {
      if (running) return { kind: 'skipped', why: 'already scanning' };
      const now = deps.now();
      if (lastScanAt !== null && now - lastScanAt < DETECT_EVERY_MS && now >= lastScanAt) return { kind: 'skipped', why: 'too soon' };
      const gate = blocked();
      if (gate) return { kind: 'skipped', why: gate };
      running = true;
      aborted = false;
      try {
        if (!(await deps.bluetoothReady().catch(() => false))) return { kind: 'skipped', why: 'bluetooth not ready' };
        const mph = await deps.speedMph().catch(() => null);
        if (mph === null || mph >= DETECT_MAX_MPH) return { kind: 'skipped', why: 'moving or speed unknown' };
        const again = blocked();
        if (again) return { kind: 'skipped', why: again };
        const snoozes = await deps.snoozes().catch(() => ({}) as Record<string, number>);
        lastScanAt = deps.now();
        const paired = deps.pairedPeripheralId();
        let best: Found | null = null;
        const session = await deps.scan({
          seconds: DETECT_SCAN_SECONDS,
          onHit: (hit) => {
            if (hit.adv !== 'new' || hit.rssi < DETECT_MIN_RSSI) return;
            if (paired !== null && hit.id.toLowerCase() === paired.toLowerCase()) return;
            const until = snoozes[hit.id];
            if (typeof until === 'number' && until > deps.now()) return;
            if (!best || hit.rssi > best.rssi) best = { id: hit.id, name: hit.name ?? 'DashPal', rssi: hit.rssi };
          },
        });
        stop = session.stop;
        const end = deps.now() + DETECT_SCAN_SECONDS * 1000;
        while (!aborted && deps.now() < end && blocked() === null) await deps.sleep(250);
        await session.stop().catch((e: unknown) => deps.onError?.(e, 'stopScan'));
        stop = null;
        if (aborted || blocked() !== null) return { kind: 'skipped', why: 'interrupted' };
        const found = best as Found | null;
        return found ? { kind: 'found', found } : { kind: 'none' };
      } catch (e) {
        deps.onError?.(e, 'detect');
        return { kind: 'skipped', why: 'error' };
      } finally {
        running = false;
      }
    },

    async abort() {
      aborted = true;
      const s = stop;
      stop = null;
      await s?.().catch(() => {});
    },
  };
}

/** The snooze map after "Not now" on `id`. */
export function snoozed(map: Record<string, number>, id: string, now: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) if (typeof v === 'number' && v > now) next[k] = v;
  next[id] = now + SNOOZE_MS;
  return next;
}
