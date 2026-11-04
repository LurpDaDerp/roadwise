/**
 * The weather heads-up before the usual commute: a LOCAL notification scheduled on the phone for
 * half an hour before the driver usually leaves on a commute leg, when the forecast there names a
 * danger ("Freezing rain" · "Expected around 7:40 AM, when you usually leave for work. Give yourself
 * extra time."). Tapping it opens Home. The rules are in `commutePlan.ts`; this module reads the
 * phone's drives and places, asks for the forecast and keeps the OS's list in step.
 *
 * - **When it plans.** With RoadWise coming to the front (at most every `HEADS_UP_FOREGROUND_MS`;
 *   `HEADS_UP_RETRY_MS` after a forecast that failed; a front while a drive is open plans once it
 *   closes), after a drive closes (a passenger's "Not driving?" too), when the switch is turned on,
 *   and when the saved places or the phone's copy of the quiet hours change
 *   (`requestCommuteReplan`). No background task: a heads-up is planned from the forecast of the
 *   last time RoadWise ran, and the content is fixed when it is scheduled.
 * - **One per leg** (`weather-commute:home-work`), replaced at each plan. A forecast that fails or
 *   falls short keeps the one scheduled for the same departure (or the one a drive took down) and
 *   takes back any other; a forecast with no danger takes it back.
 * - **Never while driving.** Every heads-up (scheduled and shown) is taken down the moment a drive
 *   starts recording, and nothing is planned while one is open; the plan after the drive puts back
 *   the ones still ahead (from a fresh forecast, else as they were).
 * - **Spaced**: at most one per `HEADS_UP_SPACING_MS`, the ones already shown counted.
 * - **Taken down** too when the switch is turned off, at sign-out, at the device wipe and at an
 *   account handover (`cancelCommuteHeadsUps`), and a shown one an hour after its departure.
 * - **Read only.** Nothing here asks for notification permission (granted or provisional only), and
 *   nothing here starts a drive. The forecast goes out for the leg's start place rounded to 0.1°.
 */
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import { COMMUTE_WINDOW_DAYS, type CommuteDrive, type CommutePlace } from '@/core/places/commute';
import { readSavedPlaces } from '@/core/places/store';
import { createSettingsRepo, type Db } from '@/data/db';
import type { DriveHost, LastFinalized } from '@/drive/host';
import { ensureNotificationSetup } from '@/features/notifications/categories';
import { readQuietHours } from '@/features/settings/notifications/quietHours';
import { deviceZone } from '@/lib/deviceZone';

import { departureWeather, HEADS_UP_LEAD_MIN, HEADS_UP_SPACING_MS, localClock, planDepartures, spaced, type LastEnd, type PlannedDeparture } from './commutePlan';
import { setCommuteReplan } from './cancelHeadsUps';
import { readCommuteHeadsUp } from './commuteSetting';
import { clockOfMinute, commuteHeadsUpCopy } from './copy';
import type { DangerKind } from './danger';
import { fetchForecast, type HourlyForecast } from './forecast';
import { roundCoord } from './openMeteo';

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

/** `content.data.kind` of every heads-up, so the lists and cancels find only ours. */
export const WEATHER_COMMUTE_KIND = 'weatherCommute';
/** The Android channel (created by `ensureAndroidChannels`). */
export const HEADS_UP_CHANNEL_ID = 'updates';
/** Where a tap goes. */
export const HEADS_UP_HREF = '/home';
/** Coming to the front plans again at most this often… */
export const HEADS_UP_FOREGROUND_MS = 30 * MIN_MS;
/** …or this soon after a plan whose forecast failed. */
export const HEADS_UP_RETRY_MS = 5 * MIN_MS;
/** A shown heads-up is taken down this long after its departure. */
export const HEADS_UP_STALE_MS = 60 * MIN_MS;

export interface HeadsUpRequest {
  identifier: string;
  title: string;
  body: string;
  /** When it shows (epoch ms). */
  fireAt: number;
  /** The departure it is for (epoch ms). */
  departAt: number;
  leg: string;
}

/** A heads-up the OS holds: pending (scheduled) or delivered (in Notification Center). */
export interface HeadsUpEntry {
  identifier: string;
  departAt: number | null;
  /** When it was due to show (null: not known). */
  fireAt: number | null;
  delivered: boolean;
  title?: string;
  body?: string;
}

/** Everything this module asks of the OS. */
export interface HeadsUpPort {
  /** Read only — never prompts. */
  permissionGranted(): Promise<boolean>;
  /** Schedule (or replace) one, by identifier. */
  schedule(req: HeadsUpRequest): Promise<void>;
  list(): Promise<HeadsUpEntry[]>;
  /** Take back a pending one (a delivered one stays). */
  unschedule(identifier: string): Promise<void>;
  /** Take a delivered one out of Notification Center (a pending one stays). */
  dismiss(identifier: string): Promise<void>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numberIn = (data: unknown, key: 'departAt' | 'fireAt'): number | null => {
  const v = (data as Record<string, unknown> | null | undefined)?.[key];
  return finite(v) ? v : null;
};
const entryOf = (identifier: string, content: { title?: string | null; body?: string | null; data?: unknown }, delivered: boolean): HeadsUpEntry => ({
  identifier,
  departAt: numberIn(content.data, 'departAt'),
  fireAt: numberIn(content.data, 'fireAt'),
  delivered,
  ...(typeof content.title === 'string' ? { title: content.title } : {}),
  ...(typeof content.body === 'string' ? { body: content.body } : {}),
});

export function createExpoHeadsUpPort(): HeadsUpPort {
  return {
    async permissionGranted() {
      const p = await Notifications.getPermissionsAsync();
      return p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    },
    async schedule(req) {
      await ensureNotificationSetup();
      await Notifications.scheduleNotificationAsync({
        identifier: req.identifier,
        content: {
          title: req.title,
          body: req.body,
          data: { kind: WEATHER_COMMUTE_KIND, url: HEADS_UP_HREF, leg: req.leg, departAt: req.departAt, fireAt: req.fireAt },
          sound: false,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: req.fireAt, channelId: HEADS_UP_CHANNEL_ID },
      });
    },
    async list() {
      const [pending, presented] = await Promise.all([
        Notifications.getAllScheduledNotificationsAsync(),
        Notifications.getPresentedNotificationsAsync().catch(() => [] as Notifications.Notification[]),
      ]);
      return [
        ...pending.filter((n) => n.content.data?.kind === WEATHER_COMMUTE_KIND).map((n) => entryOf(n.identifier, n.content, false)),
        ...presented.filter((n) => n.request.content.data?.kind === WEATHER_COMMUTE_KIND).map((n) => entryOf(n.request.identifier, n.request.content, true)),
      ];
    },
    async unschedule(identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier);
    },
    async dismiss(identifier) {
      await Notifications.dismissNotificationAsync(identifier);
    },
  };
}

/** Every heads-up, scheduled and shown, taken down; resolves with the ones it found. Never rejects; one that won't go is left. */
export async function removeAllHeadsUps(port: HeadsUpPort): Promise<HeadsUpEntry[]> {
  const entries = await port.list().catch((): HeadsUpEntry[] => []);
  for (const e of entries) await (e.delivered ? port.dismiss(e.identifier) : port.unschedule(e.identifier)).catch(() => {});
  return entries;
}

/** When a heads-up was (or is) due: as stored, else its departure less the lead. */
const dueAt = (e: HeadsUpEntry): number | null => e.fireAt ?? (e.departAt === null ? null : e.departAt - HEADS_UP_LEAD_MIN * MIN_MS);

// ——— what the phone knows ———

/** The commute's inputs from the phone's database: the kept drives of the window and where the last of them ended. */
export async function readCommuteInputs(db: Db, now: number): Promise<{ drives: CommuteDrive[]; last: LastEnd | null }> {
  const { rows } = await db.execute(
    `SELECT started_at, tz, from_place, to_place, start_lat, start_lng, end_lat, end_lng
       FROM trips
      WHERE status IN ('pending', 'scored', 'unscored', 'failed') AND archived_at IS NULL
        AND started_at >= ? AND started_at <= ?
      ORDER BY started_at ASC`,
    [now - COMMUTE_WINDOW_DAYS * DAY_MS, now]
  );
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const point = (lat: unknown, lng: unknown) => (finite(lat) && finite(lng) ? { lat, lng } : null);
  const drives: CommuteDrive[] = [];
  for (const r of rows) {
    if (!finite(r.started_at)) continue;
    drives.push({
      startedAt: r.started_at,
      tz: text(r.tz),
      fromPlace: text(r.from_place),
      toPlace: text(r.to_place),
      start: point(r.start_lat, r.start_lng),
      end: point(r.end_lat, r.end_lng),
    });
  }
  const tail = drives[drives.length - 1];
  return { drives, last: tail ? { toPlace: tail.toPlace ?? null, end: tail.end ?? null } : null };
}

// ——— one plan ———

export interface ReplanDeps {
  db: Db;
  port: HeadsUpPort;
  now: () => number;
  /** The phone's time zone. */
  tz: () => string;
  forecast: (lat: number, lng: number) => Promise<HourlyForecast | null>;
  /**
   * Runs each OS change in order with every other one (the module's queue), so a take-down asked
   * meanwhile always lands after it. Default: at once.
   */
  write?: (fn: () => Promise<void>) => Promise<void>;
  /** Asked before each change: false (a drive started, the switch went off, a wipe) changes nothing more. */
  stillWanted?: () => boolean;
  /**
   * The heads-ups a drive took down when it started: a pending one is put back as it was when the
   * forecast for its departure can't be had now, and a shown one still counts for the spacing.
   */
  takenDown?: readonly HeadsUpEntry[];
}

/** `planned`: every forecast answered; `partial`: one failed (kept as it was); `off`/`denied`: nothing is planned; `abandoned`: stopped part way. */
export type ReplanOutcome = 'planned' | 'partial' | 'off' | 'denied' | 'abandoned';

type Choice = PlannedDeparture & { kind: DangerKind | null; keep: boolean; restore?: { title: string; body: string } };

/** Plan every leg once and bring the OS's list in step with it. */
export async function replanHeadsUps(deps: ReplanDeps): Promise<ReplanOutcome> {
  const write = deps.write ?? ((fn) => fn());
  const wanted = deps.stillWanted ?? (() => true);
  const settings = createSettingsRepo(deps.db);
  const removeAll = async () => {
    await removeAllHeadsUps(deps.port);
  };
  if (!(await readCommuteHeadsUp(settings))) {
    await write(removeAll);
    return 'off';
  }
  if (!(await deps.port.permissionGranted().catch(() => false))) {
    await write(removeAll);
    return 'denied';
  }
  const now = deps.now();
  const tz = deps.tz();
  const [places, inputs, quiet] = await Promise.all([readSavedPlaces(deps.db), readCommuteInputs(deps.db, now), readQuietHours(settings)]);
  const planned = planDepartures({ drives: inputs.drives, places, last: inputs.last, now, tz, quiet });

  // The forecast once per start cell: Home → Work and Home → School read one answer.
  const forecasts = new Map<string, Promise<HourlyForecast | null>>();
  const forecastAt = (p: CommutePlace) => {
    const key = `${roundCoord(p.lat)},${roundCoord(p.lng)}`;
    let f = forecasts.get(key);
    if (!f) {
      f = deps.forecast(p.lat, p.lng).catch(() => null);
      forecasts.set(key, f);
    }
    return f;
  };
  let failed = false;
  const existing = await deps.port.list().catch((): HeadsUpEntry[] => []);
  const takenDown = deps.takenDown ?? [];
  const same = (p: PlannedDeparture) => (e: HeadsUpEntry) => !e.delivered && e.identifier === p.identifier && e.departAt === p.departAt;
  const choices: Choice[] = [];
  for (const p of planned) {
    const weather = departureWeather(await forecastAt(p.from), p.departAt);
    if (weather.known) {
      if (weather.kind !== null) choices.push({ ...p, kind: weather.kind, keep: false });
      continue;
    }
    // Unknown: the one already scheduled for this same departure stands, or goes back if a drive took it down.
    failed = true;
    if (existing.some(same(p))) {
      choices.push({ ...p, kind: null, keep: true });
      continue;
    }
    const was = takenDown.find(same(p));
    if (was?.title !== undefined && was.body !== undefined) choices.push({ ...p, kind: null, keep: false, restore: { title: was.title, body: was.body } });
  }
  if (!wanted()) return 'abandoned';
  // The ones already shown count for the spacing.
  const shown: number[] = [];
  for (const e of [...existing, ...takenDown]) {
    const t = e.delivered ? dueAt(e) : null;
    if (t !== null && !choices.some((c) => c.identifier === e.identifier && c.departAt === e.departAt)) shown.push(t);
  }
  const chosen = spaced(choices, shown);

  let abandoned = false;
  await write(async () => {
    if (!wanted()) {
      abandoned = true;
      return;
    }
    const held = await deps.port.list().catch((): HeadsUpEntry[] => []);
    const wantIds = new Set(chosen.map((c) => c.identifier));
    const at = deps.now();
    for (const e of held) {
      if (e.delivered) {
        // Shown and its departure long past (or unknown): it says nothing any more.
        if (e.departAt === null || at > e.departAt + HEADS_UP_STALE_MS) await deps.port.dismiss(e.identifier).catch(() => {});
      } else if (!wantIds.has(e.identifier)) {
        await deps.port.unschedule(e.identifier).catch(() => {});
      }
    }
    for (const c of chosen) {
      if (c.keep) continue;
      const words =
        c.restore ?? (c.kind === null ? null : { title: commuteHeadsUpCopy.title(c.kind), body: commuteHeadsUpCopy.body(c.kind, c.to, clockOfMinute(localClock(c.departAt, tz).minute)) });
      if (words === null) continue;
      if (!wanted()) {
        abandoned = true;
        return;
      }
      // A heads-up the plan took this long to reach is no longer worth sending.
      if (c.fireAt <= deps.now()) continue;
      await deps.port.schedule({ identifier: c.identifier, ...words, fireAt: c.fireAt, departAt: c.departAt, leg: c.legId });
    }
  });
  if (abandoned) return 'abandoned';
  return failed ? 'partial' : 'planned';
}

// ——— the live planner ———

/** React Native's `AppState`, narrowed. */
export interface HeadsUpAppState {
  currentState?: string | null;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

export interface CommuteHeadsUpDeps {
  db: Db;
  port?: HeadsUpPort;
  appState?: HeadsUpAppState;
  now?: () => number;
  tz?: () => string;
  forecast?: (lat: number, lng: number) => Promise<HourlyForecast | null>;
  /** Whether a driver is signed in. Signed out, nothing is planned (and what is left is taken down). Default: yes. */
  signedIn?: () => Promise<boolean>;
  onError?: (e: unknown, ctx: string) => void;
}

export interface CommuteHeadsUp {
  /** Plan now, past the throttle (the switch turned on). */
  replan(): void;
  /** Take every heads-up down, and stop a plan under way from scheduling. */
  cancelAll(): Promise<void>;
  /** Resolves once the work queued so far has finished. */
  settled(): Promise<void>;
  detach(): void;
}

let live: CommuteHeadsUp | null = null;

/**
 * Take every heads-up down (the switch off, sign-out, the device wipe, an account handover), and
 * stop the live planner's plan under way from scheduling. Never rejects.
 */
export async function cancelCommuteHeadsUps(port?: HeadsUpPort): Promise<void> {
  try {
    if (live !== null && port === undefined) await live.cancelAll();
    else await removeAllHeadsUps(port ?? createExpoHeadsUpPort());
  } catch {
    // nothing scheduled can be reached: nothing to take down
  }
}

/** Plan again now, past the throttle (the switch turned on, the places or the quiet hours changed). Without a live planner, the next one plans at its start. */
export function requestCommuteReplan(): void {
  live?.replan();
}

type Why = 'front' | 'drive' | 'asked';

export function attachCommuteHeadsUp(host: Pick<DriveHost, 'subscribe' | 'snapshot'>, deps: CommuteHeadsUpDeps): CommuteHeadsUp {
  const port = deps.port ?? createExpoHeadsUpPort();
  const appState = deps.appState ?? AppState;
  const now = deps.now ?? Date.now;
  const tz = deps.tz ?? deviceZone;
  const forecast = deps.forecast ?? ((lat: number, lng: number) => fetchForecast(lat, lng));
  const signedIn = deps.signedIn ?? (async () => true);
  const report = (e: unknown, ctx: string) => deps.onError?.(e, ctx);

  let detached = false;
  /** Bumped by every take-down: a plan begun before one schedules nothing. */
  let generation = 0;
  /** The OS changes, one at a time in order. */
  let osChain: Promise<void> = Promise.resolve();
  /** The plan under way, and whether another was asked for meanwhile (and why). */
  let running: Promise<void> | null = null;
  let again: Why | null = null;
  let last: { at: number; ok: boolean } | null = null;
  let afterDrive = false;
  /** A front that came while a drive was open: it plans once the drive has closed. */
  let frontWaiting = false;
  /** What the drives took down when they started (`ReplanDeps.takenDown`). */
  let takenDown: HeadsUpEntry[] = [];
  /** The drive the heads-ups were last taken down for (undefined: none since the last idle). */
  let cancelledFor: string | null | undefined;
  let seen: LastFinalized = host.snapshot().lastFinalized;
  let state = appState.currentState;

  const idle = () => host.snapshot().status === 'idle';

  const write = (fn: () => Promise<void>): Promise<void> => {
    // The caller hears of a failure; the queue goes on.
    const run = osChain.then(fn);
    osChain = run.catch(() => {});
    return run;
  };

  const cancelAll = (): Promise<void> => {
    generation += 1;
    takenDown = [];
    return write(async () => {
      await removeAllHeadsUps(port);
      takenDown = [];
    }).catch((e: unknown) => report(e, 'weather heads-up'));
  };

  /** A drive started recording: every heads-up comes down, remembered for the plan after it. */
  const takeDownForDrive = (): void => {
    generation += 1;
    // The plan after the drive runs past the throttle.
    last = null;
    void write(async () => {
      const gone = await removeAllHeadsUps(port);
      const t = now();
      // Kept while one could still be put back, or still counts for the spacing.
      takenDown = [...takenDown.filter((e) => !gone.some((g) => g.identifier === e.identifier)), ...gone].filter((e) => {
        const due = dueAt(e);
        return e.delivered ? due !== null && due + HEADS_UP_SPACING_MS > t : e.departAt !== null && e.departAt > t;
      });
    }).catch((e: unknown) => report(e, 'weather heads-up'));
  };

  const due = (why: Why): boolean => {
    if (why !== 'front' || last === null) return true;
    const t = now();
    if (t < last.at) return true;
    return t - last.at >= (last.ok ? HEADS_UP_FOREGROUND_MS : HEADS_UP_RETRY_MS);
  };

  async function plan(why: Why): Promise<void> {
    if (detached) return;
    if (!idle()) {
      // A drive is open: the front waits for it to close.
      if (why === 'front') frontWaiting = true;
      return;
    }
    if (!due(why)) return;
    // A take-down still under way lands first, so the plan sees what it took down.
    await osChain;
    if (!(await signedIn().catch(() => true))) {
      await cancelAll();
      return;
    }
    const gen = generation;
    const outcome = await replanHeadsUps({
      db: deps.db,
      port,
      now,
      tz,
      forecast,
      write,
      stillWanted: () => !detached && gen === generation && idle(),
      takenDown,
    });
    // Only a plan that asked for the forecast holds the next one off: switched off or no
    // permission costs nothing to look at again (a permission granted later plans at once).
    if (outcome === 'planned' || outcome === 'partial') {
      last = { at: now(), ok: outcome === 'planned' };
      // A pending one a drive took down has had its plan; a shown one still counts for the spacing.
      takenDown = takenDown.filter((e) => e.delivered);
    } else if (outcome !== 'abandoned') last = null;
  }

  function request(why: Why): void {
    if (detached) return;
    if (running !== null) {
      // The stronger reason wins: a drive's end or the switch plans past the throttle.
      if (again === null || again === 'front') again = why;
      return;
    }
    running = plan(why)
      .catch((e: unknown) => report(e, 'weather heads-up'))
      .finally(() => {
        running = null;
        const next = again;
        again = null;
        if (next !== null) request(next);
      });
  }

  const onSnapshot = (s: ReturnType<typeof host.snapshot>) => {
    // A drive records: nothing may show while it does.
    if (s.status === 'recording' && (cancelledFor === undefined || s.clientTripId !== cancelledFor)) {
      cancelledFor = s.clientTripId;
      takeDownForDrive();
    }
    const f = s.lastFinalized;
    if (f !== seen && f !== null) {
      const fresh = seen === null || f.clientTripId !== seen.clientTripId || f.at !== seen.at;
      seen = f;
      // Any drive that closes, a passenger's "Not driving?" too: a plan only looks at departures ahead.
      if (fresh) afterDrive = true;
    }
    if (s.status === 'idle') {
      // A drive took the heads-ups down: the plan after it puts back the ones still ahead.
      const tookDown = cancelledFor !== undefined;
      cancelledFor = undefined;
      if (afterDrive || tookDown) {
        afterDrive = false;
        frontWaiting = false;
        request('drive');
      } else if (frontWaiting) {
        frontWaiting = false;
        request('front');
      }
    }
  };

  const off = host.subscribe(onSnapshot);
  onSnapshot(host.snapshot());
  const sub = appState.addEventListener('change', (next) => {
    state = next;
    if (next === 'active') request('front');
  });
  if (state === 'active') request('front');

  const self: CommuteHeadsUp = {
    replan: () => request('asked'),
    cancelAll,
    async settled() {
      while (running !== null) await running;
      await osChain;
    },
    detach() {
      detached = true;
      generation += 1;
      off();
      sub.remove();
      if (live === self) {
        live = null;
        setCommuteReplan(null);
      }
    },
  };
  live = self;
  setCommuteReplan(() => self.replan());
  return self;
}
