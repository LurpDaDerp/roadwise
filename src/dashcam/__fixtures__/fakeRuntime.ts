// A DashPal runtime stand-in for screen tests: a state the test sets, and every action recorded.
import type { LinkSnapshot } from '../link';
import type { PairedDashcam } from '../keys';
import type { DashcamRuntime, DashcamState } from '../runtime';
import type { DashcamTransport } from '../transport';

export const PAIRED: PairedDashcam = { dashcamId: 'a4cf12b3c4d5', peripheralId: 'AA:BB:CC:DD:EE:FF', name: 'DashPal-C4D5', pairedAt: 1, secure: true };

export function linkSnapshot(over: Partial<LinkSnapshot> = {}): LinkSnapshot {
  return {
    lifecycle: 'unpaired',
    paired: null,
    repairCause: null,
    status: null,
    synced: false,
    visual: null,
    held: null,
    firmware: null,
    counters: { badFrames: 0, lateAlerts: 0, stored: 0, ignored: 0, duplicates: 0, orphanEvents: 0, storeErrors: 0 },
    ...over,
  };
}

export interface FakeDashcamRuntime extends DashcamRuntime {
  log: string[];
  set(state: Partial<Omit<DashcamState, 'link'>> & { link?: Partial<LinkSnapshot> }): void;
  commandResult: boolean;
  transportValue: DashcamTransport | null;
  /** what addPhone resolves with */
  addPhoneResult: { openedAt: number } | null;
}

export function createFakeDashcamRuntime(initial: Partial<Omit<DashcamState, 'link'>> & { link?: Partial<LinkSnapshot> } = {}): FakeDashcamRuntime {
  const listeners = new Set<(s: DashcamState) => void>();
  let state: DashcamState = { buzzerToo: false, btOptIn: false, loaded: true, newPhone: false, reaim: false, ...initial, link: linkSnapshot(initial.link) };
  const log: string[] = [];
  const rt: FakeDashcamRuntime = {
    log,
    commandResult: true,
    transportValue: null,
    set(next) {
      state = { ...state, ...next, link: { ...state.link, ...(next.link ?? {}) } };
      for (const fn of [...listeners]) fn(state);
    },
    ready: Promise.resolve(),
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    link: {} as DashcamRuntime['link'],
    transport: () => rt.transportValue,
    row: () => {},
    adopt: async () => {},
    estimateOn: () => false,
    beforeFinalize: async () => {},
    facts: async () => ({ dashcamId: null, movingS: 0, coveredS: 0, synced: false, events: [] }),
    continuousAlertActive: () => false,
    playerUnavailable: () => {},
    async optIn() {
      log.push('optIn');
      rt.set({ btOptIn: true });
    },
    async setBuzzerToo(on) {
      log.push(`buzzerToo:${on}`);
      rt.set({ buzzerToo: on });
    },
    async pair(record) {
      log.push(`pair:${record.dashcamId}`);
      rt.set({ link: { ...state.link, paired: record, lifecycle: 'connecting' } });
    },
    stepAside() {
      log.push('stepAside');
    },
    async resumePaired() {
      log.push('resumePaired');
    },
    addPhoneResult: null,
    async addPhone() {
      log.push('addPhone');
      return rt.addPhoneResult;
    },
    notePhones(dashcamId, phones) {
      log.push(`notePhones:${dashcamId}:${phones}`);
    },
    async dismissNewPhone() {
      log.push('dismissNewPhone');
      rt.set({ newPhone: false });
    },
    async forget() {
      log.push('forget');
      rt.set({ link: { ...state.link, paired: null, lifecycle: 'unpaired' } });
    },
    async command(op, arg = 0) {
      log.push(`command:${op}:${arg}`);
      return rt.commandResult;
    },
    pruneUnattached: async () => 0,
    restartLink: () => void log.push('restartLink'),
    dispose: () => {},
  };
  return rt;
}
