// Home's DashPal card: after the driver opted in, a DashPal ready to pair nearby is offered on Home
// ("Pair DashPal-XXXX?"), never while driving and never with a permission prompt.
//
// An 8 s scan for the pairing services `00f0` (no phone paired) and `00f2` (phones paired, pairing
// open) when Home comes into view, when RoadWise returns to the front with Home showing, and on pull
// to refresh: at most once per minute (pull to refresh at most once per 10 s; a scan cut short does
// not count, but no scan starts within 10 s of the last start), and only when: opted
// in; Bluetooth already allowed and on (read, never asked); no drive open or closing; Home showing
// and RoadWise in front; no speed probe of 3 mph or more (an unknown speed, as indoors, does not block:
// a drive open already does); no setup open; the paired
// DashPal not connected. What a hit offers (`classify`): a DashPal with no phone paired (`new`), or
// this phone's own DashPal once it no longer knows this phone (`again`); at −80 dBm or stronger, not
// snoozed ("Not now", 7 days), the strongest one. Pure apart from its injected reads.
import { PAIRING_NEW, PAIRING_OPEN, type AdvState } from './protocol';
import type { ScanHit } from './transport';

export const DETECT_SCAN_SECONDS = 8;
export const DETECT_EVERY_MS = 60_000;
/** Pull to refresh may scan again this soon after the last scan. */
export const DETECT_PULL_EVERY_MS = 10_000;
/**
 * No scan starts sooner than this after the last start, whatever asks (a scan cut short included):
 * Android refuses a sixth scan start within 30 s.
 */
export const DETECT_MIN_GAP_MS = 10_000;
export const DETECT_MAX_MPH = 3;
export const DETECT_MIN_RSSI = -80;
export const SNOOZE_MS = 7 * 24 * 60 * 60_000;
/** The services Home's scan listens for: no phone paired, and pairing open with phones paired. */
export const DETECT_SERVICES = [PAIRING_NEW, PAIRING_OPEN] as const;

/** What the card offers: a new DashPal, or setting up this phone's own DashPal again. */
export type CardKind = 'new' | 'again';

export interface Found {
  id: string;
  name: string;
  rssi: number;
  kind: CardKind;
  adv: AdvState;
}

/** This phone's pairing as the card needs it. */
export interface PairedView {
  peripheralId: string;
  name: string;
  /** the paired DashPal refused this phone's key at its last session (R_UNKNOWN_PHONE) */
  unknownPhone: boolean;
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The card one advert offers, or null. This phone's own DashPal: `again` when it advertises no phone
 * paired, or pairing open while it refused this phone's key. Any other DashPal: `new` only with no
 * phone paired, and never while the paired one is connected.
 */
export function classify(adv: AdvState | null, id: string, paired: PairedView | null, pairedConnected: boolean): CardKind | null {
  if (paired && sameId(id, paired.peripheralId)) return adv === 'new' || (adv === 'open' && paired.unknownPhone) ? 'again' : null;
  if (paired && pairedConnected) return null;
  return adv === 'new' ? 'new' : null;
}

export interface DetectorDeps {
  now(): number;
  btOptIn(): boolean;
  /** Bluetooth already allowed and on (a read: never a prompt). */
  bluetoothReady(): Promise<boolean>;
  /** A drive open or closing. */
  isBusy(): boolean;
  /** Home is showing and RoadWise is in front. */
  onHome(): boolean;
  /** mph, or null when unknown */
  speedMph(): Promise<number | null>;
  /** The setup sheet is open. */
  setupOpen(): boolean;
  paired(): PairedView | null;
  pairedConnected(): boolean;
  /** `{ [peripheralId]: snoozedUntilMs }` */
  snoozes(): Promise<Record<string, number>>;
  scan(opts: { services: readonly string[]; seconds: number; onHit(hit: ScanHit): void }): Promise<{ stop(): Promise<void> }>;
  sleep(ms: number): Promise<void>;
  onError?(e: unknown, ctx: string): void;
}

export type DetectOutcome = { kind: 'found'; found: Found } | { kind: 'skipped'; why: string } | { kind: 'none' };

export interface Detector {
  /** Run the gates and maybe one scan (`pull`: pull to refresh, at most once per 10 s). */
  check(opts?: { pull?: boolean }): Promise<DetectOutcome>;
  /** Stop a scan in progress (Home left, RoadWise left the front, a drive started). */
  abort(): Promise<void>;
}

export function createDetector(deps: DetectorDeps): Detector {
  /** The start of the last scan that ran to its end (the once-a-minute limit). */
  let lastScanAt: number | null = null;
  /** The start of the last scan, cut short or not (the 10 s floor). */
  let lastStartAt: number | null = null;
  let current: Promise<DetectOutcome> | null = null;
  let aborted = false;
  let stop: (() => Promise<void>) | null = null;
  const within = (at: number | null, ms: number, now: number): boolean => at !== null && now - at < ms && now >= at;

  /** The gates that need no I/O, re-checked after every wait. */
  function blocked(): string | null {
    if (!deps.btOptIn()) return 'not opted in';
    if (deps.isBusy()) return 'drive open';
    if (!deps.onHome()) return 'not on Home';
    if (deps.setupOpen()) return 'setup open';
    if (deps.paired() && deps.pairedConnected()) return 'paired dashcam connected';
    return null;
  }

  async function check(opts: { pull?: boolean } = {}): Promise<DetectOutcome> {
    while (current) {
      if (!aborted) return { kind: 'skipped', why: 'already scanning' };
      // A check being cut short (Home left and back while it waited): look again once it has ended.
      await current.catch(() => undefined);
    }
    const run = runCheck(opts);
    current = run;
    void run
      .finally(() => {
        if (current === run) current = null;
      })
      .catch(() => undefined);
    return run;
  }

  async function runCheck(opts: { pull?: boolean }): Promise<DetectOutcome> {
    const now = deps.now();
    const every = opts.pull ? DETECT_PULL_EVERY_MS : DETECT_EVERY_MS;
    if (within(lastScanAt, every, now) || within(lastStartAt, DETECT_MIN_GAP_MS, now)) return { kind: 'skipped', why: 'too soon' };
    const gate = blocked();
    if (gate) return { kind: 'skipped', why: gate };
    aborted = false;
    try {
      if (!(await deps.bluetoothReady().catch(() => false))) return { kind: 'skipped', why: 'bluetooth not ready' };
      const mph = await deps.speedMph().catch(() => null);
      if (mph !== null && mph >= DETECT_MAX_MPH) return { kind: 'skipped', why: 'moving' };
      const again = blocked();
      if (again) return { kind: 'skipped', why: again };
      const snoozes = await deps.snoozes().catch(() => ({}) as Record<string, number>);
      if (aborted || blocked() !== null) return { kind: 'skipped', why: 'interrupted' };
      const startedAt = deps.now();
      lastStartAt = startedAt;
      const paired = deps.paired();
      const connected = deps.pairedConnected();
      let best: Found | null = null;
      const session = await deps.scan({
        services: DETECT_SERVICES,
        seconds: DETECT_SCAN_SECONDS,
        onHit: (hit) => {
          if (hit.rssi < DETECT_MIN_RSSI || !hit.adv) return;
          const kind = classify(hit.adv, hit.id, paired, connected);
          if (!kind) return;
          const until = snoozes[hit.id];
          if (typeof until === 'number' && until > deps.now()) return;
          if (!best || hit.rssi > best.rssi) {
            const name = hit.name ?? (kind === 'again' ? paired?.name : null) ?? 'DashPal';
            best = { id: hit.id, name, rssi: hit.rssi, kind, adv: hit.adv };
          }
        },
      });
      stop = session.stop;
      const end = deps.now() + DETECT_SCAN_SECONDS * 1000;
      while (!aborted && deps.now() < end && blocked() === null) await deps.sleep(250);
      await session.stop().catch((e: unknown) => deps.onError?.(e, 'stopScan'));
      stop = null;
      if (aborted || blocked() !== null) return { kind: 'skipped', why: 'interrupted' };
      lastScanAt = startedAt;
      const found = best as Found | null;
      return found ? { kind: 'found', found } : { kind: 'none' };
    } catch (e) {
      deps.onError?.(e, 'detect');
      return { kind: 'skipped', why: 'error' };
    }
  }

  return {
    check,

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
