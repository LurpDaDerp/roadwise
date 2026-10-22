// An in-memory drive detector for host and bootstrap tests, following the `DriveDetect` contract
// (plan §3.1.1) closely enough that a host tested on it behaves on a phone:
// - `wake()` opens an auto candidate when the wake gate passes, and `appForeground()` takes an `app`
//   wake when the phone has had car motion (`setCarMotion`, off by default, as at a desk);
//   `startWaiting()` opens a manual drive at once, from the tap (journaled, `driveStarted`), waiting
//   for driving speed;
// - `confirm()` turns the candidate into a recording drive, journals its `start` line and emits
//   `driveStarted`; `emitRows()` journals rows with `seq` (and, given `sense`, emits each as a
//   DriveSense `row` event, as native does);
// - `endFor()` is a native safety stop or a cancel (`driveEnded`), `jsStop()` a JS `stopCapture`;
// - `wipe()` forgets everything (journals, last end, rest, owner) and leaves it off;
// - `relaunch()` resumes the live drive as native does after a kill or a power loss (a `gap`, seqs
//   going on past it);
// - the journal is ndjson text per drive, read back by `readJournal` exactly as native reads it;
// - events nobody listens for are buffered and delivered when the first listener attaches.
import { journalLine, listedEnd, parseJournalLine, readJournal } from './detect/journal';
import { DETECT, continuesFrom, resumeSeq, statusOf, wakeGate, type WakeReason } from './detect/policy';
import type {
  DetectPermissions,
  DetectReason,
  DetectState,
  DetectSubscription,
  DriveDetectApi,
  DriveDetectEvent,
  DriveDetectEvents,
  DriveEndedEvent,
  DriveOrigin,
  DriveStartedEvent,
  EndCauseNative,
  JournaledDrive,
  StartSource,
} from './detect/types';

export interface FakeDetectOptions {
  /** Whether the module exists (default true; false = Android, Jest without a fake, web). */
  available?: boolean;
  /** The clock (default `Date.now`). */
  now?: () => number;
  /** Deliver events on a microtask, as native does. Default false. */
  asyncDelivery?: boolean;
  /** Where journaled rows are also emitted as `row` events (a fake DriveSense). */
  sense?: { emit(event: 'row', payload: unknown): void };
  permissions?: Partial<DetectPermissions>;
}

export interface FakeConfirm {
  driveId?: string;
  startedAt?: number;
  startSource?: StartSource;
  startLat?: number | null;
  startLng?: number | null;
  /** Default: native's hint from the last end. */
  continues?: boolean;
  /** Rows from the traced start, journaled (and emitted) at once. */
  rows?: readonly Record<string, unknown>[];
}

export interface FakeDetectControls {
  /** Every method call, in order (`readRows:<id>:<afterSeq>:<limit>` and `discardDrive:<id>` with arguments). */
  readonly calls: string[];
  setPermissions(p: Partial<DetectPermissions>): void;
  /** What `requestAlways` answers (default: 'always' when Always is held, else 'whenInUse'). */
  setAlwaysAnswer(a: 'always' | 'whenInUse' | 'denied'): void;
  /** A wake: an auto candidate when the gate passes (motion assumed fresh). Returns whether one opened. */
  wake(reason?: WakeReason): boolean;
  /** Car motion in the last 2 min, which `appForeground` needs to open a candidate (default false). */
  setCarMotion(fresh: boolean): void;
  /** The candidate confirms (an auto one by default when none is open). */
  confirm(c?: FakeConfirm): DriveStartedEvent;
  /** Rows journaled with the next `seq`s; returns the seqs. */
  emitRows(rows: readonly Record<string, unknown>[]): number[];
  /** Native ends the drive on its own (`cancelled` = "Not driving?"). Null when nothing records. */
  endFor(cause: EndCauseNative, at?: number): DriveEndedEvent | null;
  /** A JS `stopCapture` reached native: the end is journaled with cause `js`, no event. */
  jsStop(endedAt?: number): void;
  /** The Start-card drive reached driving speed natively (10 mph held 15 s): its wait is over (`detectState` reason `confirmed`). */
  waitOver(): void;
  /**
   * A relaunch resumes the live drive (`resumeAtLaunch`): its last `lostRows` row lines are gone from
   * the journal (a power loss before they were synced, though JS may hold them), a `gap` line reserves
   * `resumeSeq` past the journal's highest seq, and rows go on after it. The gap's seq, or null when
   * nothing records.
   */
  relaunch(lostRows?: number): number | null;
  /** Lines of each journal file (ndjson). */
  readonly journal: ReadonlyMap<string, string>;
  /** Puts a journal file in place (a drive left by an earlier process). */
  putJournal(driveId: string, text: string): void;
  setJournalDropped(n: number): void;
  listenerCount(event: DriveDetectEvent): number;
  readonly snapshot: DetectState;
}

const PERMISSIONS: DetectPermissions = {
  location: 'always',
  precise: true,
  motion: 'granted',
  backgroundRefresh: 'available',
  liveActivities: true,
  canAskAlways: false,
};

let idSeq = 0;
const newId = (): string => `00000000-0000-4000-8000-${(++idSeq).toString(16).padStart(12, '0')}`;

export function createFakeDriveDetect(opts: FakeDetectOptions = {}): DriveDetectApi & FakeDetectControls {
  const now = opts.now ?? Date.now;
  const available = opts.available ?? true;
  let permissions: DetectPermissions = { ...PERMISSIONS, ...opts.permissions };
  let alwaysAnswer: 'always' | 'whenInUse' | 'denied' | null = null;
  let carMotion = false;
  let intent = false;
  let owner: string | null = null;
  let phase: DetectState['state'] = 'off';
  let since = now();
  let origin: DriveOrigin | null = null;
  let live: { driveId: string; startedAt: number; nextSeq: number; lastRowTs: number | null } | null = null;
  let waitUntil: number | null = null;
  let lastEnd: DetectState['lastEnd'] = null;
  let suppressedUntil: number | null = null;
  let journalDropped = 0;
  const journal = new Map<string, string>();
  const calls: string[] = [];
  const listeners = new Map<DriveDetectEvent, Set<(p: unknown) => void>>();
  let buffer: { event: DriveDetectEvent; payload: unknown }[] = [];

  const status = () =>
    statusOf({ armed: intent, hardware: true, location: permissions.location, precise: permissions.precise, motion: permissions.motion, backgroundRefresh: permissions.backgroundRefresh, liveActivities: permissions.liveActivities });

  function snapshot(): DetectState {
    const s = status();
    return {
      armed: intent && owner !== null && phase !== 'off',
      ownerId: owner,
      state: phase,
      origin,
      driveId: live?.driveId ?? null,
      startedAt: live?.startedAt ?? null,
      since,
      waitUntil,
      lastEnd: lastEnd ? { ...lastEnd } : null,
      suppressedUntil,
      status: s.status,
      missing: s.missing,
      permissions: { ...permissions },
      journalDropped,
    };
  }

  function deliver(event: DriveDetectEvent, payload: unknown) {
    const set = listeners.get(event);
    if (!set || set.size === 0) {
      buffer.push({ event, payload });
      if (buffer.length > 300) buffer.shift();
      return;
    }
    for (const fn of [...set]) if (set.has(fn)) fn(payload);
  }
  function emit<E extends DriveDetectEvent>(event: E, payload: DriveDetectEvents[E]) {
    if (opts.asyncDelivery) void Promise.resolve().then(() => deliver(event, payload));
    else deliver(event, payload);
  }
  const announce = (reason: DetectReason) => emit('detectState', { ...snapshot(), reason });

  function enter(next: DetectState['state']) {
    phase = next;
    since = now();
  }
  /** Back to armed (or off without the intent or the permissions) after a candidate, a drive or a rest. */
  function settle() {
    origin = null;
    waitUntil = null;
    enter(intent && owner !== null && status().requiredOk ? 'armed' : 'off');
  }

  function append(driveId: string, line: Record<string, unknown>) {
    journal.set(driveId, (journal.get(driveId) ?? '') + journalLine(line));
  }

  function listOne(driveId: string, text: string): JournaledDrive | null {
    const j = readJournal(text);
    if (!j.start) return null;
    const last = j.rows[j.rows.length - 1];
    return {
      driveId,
      origin: j.start.origin,
      startedAt: j.start.startedAt,
      startSource: j.start.startSource,
      startLat: j.start.startLat,
      startLng: j.start.startLng,
      continues: j.start.continues,
      confirmedAt: j.start.confirmedAt,
      firstSeq: 1,
      lastSeq: j.end?.lastSeq ?? (typeof last?.seq === 'number' ? last.seq : 0),
      lastRowTs: j.end?.lastRowTs ?? (typeof last?.ts === 'number' ? last.ts : null),
      bytes: text.length,
      // A file with no end that is not the live drive is an orphan, listed as ended (as native lists it).
      ended: listedEnd(j, live?.driveId === driveId),
    };
  }

  function commit(cause: EndCauseNative | 'js', endedAt: number): DriveEndedEvent | null {
    if (!live) return null;
    const decidedAt = now();
    const ended: DriveEndedEvent = { driveId: live.driveId, endedAt, cause: cause === 'js' ? 'still' : cause, decidedAt, lastSeq: live.nextSeq - 1, lastRowTs: live.lastRowTs };
    if (cause === 'cancelled') {
      journal.delete(live.driveId);
      live = null;
      origin = null;
      waitUntil = null;
      enter('suppressed');
      suppressedUntil = decidedAt + DETECT.SUPPRESS_MAX_MS;
      emit('driveEnded', ended);
      announce('notDriving');
      return ended;
    }
    append(live.driveId, { k: 'end', endedAt, cause, decidedAt, lastRowTs: live.lastRowTs, lastSeq: live.nextSeq - 1 });
    lastEnd = { decidedAt, cut: cause === 'js' ? endedAt : decidedAt, lat: 0, lng: 0, driveId: live.driveId };
    live = null;
    settle();
    if (cause !== 'js') emit('driveEnded', ended);
    announce('ended');
    return ended;
  }

  const resolve = <T>(v: T): Promise<T> => Promise.resolve(v);
  const absent = (method: string) => Promise.reject(new Error(`DriveDetect.${method}: not available (Android, Jest, Expo Go or web)`));
  const busy = () => Object.assign(new Error('DriveDetect.discardDrive: the drive is still recording'), { code: 'E_BUSY' as const });

  const api: DriveDetectApi & FakeDetectControls = {
    get available() {
      return available;
    },
    setArmed(armed, ownerId) {
      calls.push(`setArmed:${String(armed)}`);
      if (!available) return absent('setArmed');
      if (armed && owner !== null && owner !== ownerId) lastEnd = null;
      intent = armed;
      owner = armed ? ownerId : null;
      if (phase === 'off' || phase === 'armed' || phase === 'suppressed' || (phase === 'candidate' && !armed)) {
        const was = phase;
        settle();
        if (phase !== was) announce(armed && phase === 'armed' ? 'armed' : 'disarmed');
      }
      return resolve(snapshot());
    },
    getState() {
      calls.push('getState');
      if (!available) return absent('getState');
      const s = snapshot();
      journalDropped = 0;
      return resolve(s);
    },
    requestAlways() {
      calls.push('requestAlways');
      if (!available) return absent('requestAlways');
      const answer = alwaysAnswer ?? (permissions.location === 'always' ? 'always' : permissions.location === 'whenInUse' ? 'whenInUse' : 'denied');
      if (answer === 'always') permissions = { ...permissions, location: 'always' };
      permissions = { ...permissions, canAskAlways: false };
      return resolve(answer);
    },
    startWaiting() {
      calls.push('startWaiting');
      if (!available) return absent('startWaiting');
      if (permissions.location === 'none' || !permissions.precise) return resolve({ ok: false as const, reason: 'permission' as const });
      if (phase === 'recording' || phase === 'ending') return resolve({ ok: false as const, reason: 'busy' as const });
      // The drive opens at the tap (an auto candidate gives way to it), waiting for driving speed.
      enter('candidate');
      origin = 'manual';
      suppressedUntil = null;
      announce('waiting');
      const started = api.confirm({ startedAt: now(), startSource: 'wake', startLat: null, startLng: null, continues: false });
      waitUntil = now() + DETECT.WAIT_MAX_MS;
      return resolve({ ok: true as const, waitUntil, driveId: started.driveId, startedAt: started.startedAt });
    },
    extendWaiting() {
      calls.push('extendWaiting');
      if (!available) return absent('extendWaiting');
      if ((phase !== 'recording' && phase !== 'ending') || origin !== 'manual' || waitUntil === null) return resolve(null);
      waitUntil = now() + DETECT.WAIT_MAX_MS;
      announce('extended');
      return resolve(waitUntil);
    },
    cancelWaiting() {
      calls.push('cancelWaiting');
      if (!available) return absent('cancelWaiting');
      if (phase === 'candidate' && origin === 'manual') {
        settle();
        announce('cancelled');
      }
      return resolve(undefined);
    },
    notDriving() {
      calls.push('notDriving');
      if (!available) return absent('notDriving');
      commit('cancelled', now());
      return resolve(undefined);
    },
    listDrives() {
      calls.push('listDrives');
      if (!available) return absent('listDrives');
      const out: JournaledDrive[] = [];
      for (const [id, text] of journal) {
        const d = listOne(id, text);
        if (d) out.push(d);
      }
      return resolve(out);
    },
    readRows(driveId, afterSeq, limit) {
      calls.push(`readRows:${driveId}:${afterSeq}:${limit}`);
      if (!available) return absent('readRows');
      const rows = readJournal(journal.get(driveId) ?? '').rows.filter((r) => (r.seq as number) > afterSeq);
      const page = rows.slice(0, limit);
      const lastSeq = page.length > 0 ? (page[page.length - 1]!.seq as number) : afterSeq;
      return resolve({ rows: page.map((r) => ({ ...r })), lastSeq, done: rows.length <= limit });
    },
    discardDrive(driveId) {
      calls.push(`discardDrive:${driveId}`);
      if (!available) return absent('discardDrive');
      if (live?.driveId === driveId) return Promise.reject(busy());
      journal.delete(driveId);
      return resolve(undefined);
    },
    wipe() {
      calls.push('wipe');
      // Nothing to wipe without the module (Android): a no-op that resolves, as the wrapper's.
      if (!available) return resolve(undefined);
      const waitingNow = phase === 'candidate' && origin === 'manual';
      live = null;
      journal.clear();
      intent = false;
      owner = null;
      origin = null;
      waitUntil = null;
      lastEnd = null;
      suppressedUntil = null;
      journalDropped = 0;
      enter('off');
      announce(waitingNow ? 'cancelled' : 'disarmed');
      return resolve(undefined);
    },
    appForeground() {
      calls.push('appForeground');
      // Nothing to wake without the module (Android): a no-op that resolves, as the wrapper's.
      if (available && carMotion) api.wake('app');
      return resolve(undefined);
    },
    addListener<E extends DriveDetectEvent>(event: E, fn: (p: DriveDetectEvents[E]) => void): DetectSubscription {
      if (!available) return { remove() {} };
      const listener = fn as (p: unknown) => void;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const first = set.size === 0;
      set.add(listener);
      if (first) {
        const pending = buffer.filter((b) => b.event === event);
        if (pending.length > 0) {
          buffer = buffer.filter((b) => b.event !== event);
          void Promise.resolve().then(() => {
            for (const b of pending) deliver(b.event, b.payload);
          });
        }
      }
      return { remove: () => void set.delete(listener) };
    },

    // ——— controls ———
    calls,
    setPermissions(p) {
      permissions = { ...permissions, ...p };
    },
    setAlwaysAnswer(a) {
      alwaysAnswer = a;
    },
    setCarMotion(fresh) {
      carMotion = fresh;
    },
    wake(reason = 'slc') {
      const gate = wakeGate({
        now: now(),
        reason,
        phase,
        armed: intent,
        hasOwner: owner !== null,
        permissionsOk: status().requiredOk,
        candidateRestUntil: 0,
        candidateStarts: [],
      });
      if (gate !== 'ok') return false;
      enter('candidate');
      origin = 'auto';
      announce(`wake:${reason}`);
      return true;
    },
    confirm(c = {}) {
      if (phase !== 'candidate') {
        enter('candidate');
        origin = 'auto';
      }
      const t = now();
      const driveId = c.driveId ?? newId();
      const startedAt = c.startedAt ?? t;
      const startLat = c.startLat ?? null;
      const startLng = c.startLng ?? null;
      const started: DriveStartedEvent = {
        driveId,
        origin: origin ?? 'auto',
        startedAt,
        startSource: c.startSource ?? 'trace',
        startLat,
        startLng,
        continues: c.continues ?? continuesFrom(lastEnd, startedAt, startLat, startLng),
        confirmedAt: t,
        firstSeq: 1,
      };
      append(driveId, { k: 'start', v: 1, ...started, nativeBuild: 'fake' });
      live = { driveId, startedAt, nextSeq: 1, lastRowTs: null };
      waitUntil = null;
      enter('recording');
      if (c.rows) api.emitRows(c.rows);
      emit('driveStarted', started);
      announce('confirmed');
      return started;
    },
    emitRows(rows) {
      if (!live) return [];
      const seqs: number[] = [];
      for (const r of rows) {
        const seq = live.nextSeq++;
        const body = { ...r, seq };
        if (typeof r.ts === 'number') live.lastRowTs = r.ts;
        append(live.driveId, { k: 'row', ...body });
        opts.sense?.emit('row', body);
        seqs.push(seq);
      }
      return seqs;
    },
    endFor(cause, at) {
      return commit(cause, cause === 'cancelled' ? now() : (at ?? now()));
    },
    jsStop(endedAt) {
      commit('js', endedAt ?? now());
    },
    relaunch(lostRows = 0) {
      if (!live) return null;
      const lines = (journal.get(live.driveId) ?? '').split('\n').filter((l) => l !== '');
      for (let i = lines.length - 1, n = lostRows; i >= 0 && n > 0; i--) {
        if (parseJournalLine(lines[i]!)?.k !== 'row') continue;
        lines.splice(i, 1);
        n -= 1;
      }
      const text = lines.map((l) => `${l}\n`).join('');
      const kept = readJournal(text);
      const lastRow = kept.rows[kept.rows.length - 1];
      live.lastRowTs = typeof lastRow?.ts === 'number' ? lastRow.ts : null;
      const top = Math.max(typeof lastRow?.seq === 'number' ? lastRow.seq : 0, ...kept.gaps.map((g) => g.lastSeq ?? 0));
      const skipTo = resumeSeq(top);
      const gap = { k: 'gap', from: live.lastRowTs ?? live.startedAt, to: now(), lastSeq: skipTo };
      journal.set(live.driveId, text + journalLine(gap));
      live.nextSeq = skipTo + 1;
      announce('resumed');
      return skipTo;
    },
    waitOver() {
      if (live === null || waitUntil === null) return;
      waitUntil = null;
      announce('confirmed');
    },
    get journal() {
      return new Map(journal);
    },
    putJournal(driveId, text) {
      journal.set(driveId, text);
    },
    setJournalDropped(n) {
      journalDropped = n;
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    get snapshot() {
      return snapshot();
    },
  };
  return api;
}
