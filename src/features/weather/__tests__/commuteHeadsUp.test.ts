/** @jest-environment node */
import { PLACES_KEY } from '@/core/places/saved';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db, type NewTrip } from '@/data/db';
import type { DriveHost, DriveState } from '@/drive/host';
import { QUIET_HOURS_KEY } from '@/features/settings/notifications/quietHours';

import {
  attachCommuteHeadsUp,
  cancelCommuteHeadsUps,
  HEADS_UP_FOREGROUND_MS,
  HEADS_UP_RETRY_MS,
  readCommuteInputs,
  replanHeadsUps,
  requestCommuteReplan,
  type HeadsUpEntry,
  type HeadsUpPort,
  type HeadsUpRequest,
  type ReplanDeps,
} from '../commuteHeadsUp';
import { COMMUTE_HEADS_UP_KEY } from '../commuteSetting';
import type { HourlyForecast } from '../forecast';
import type { WeatherSample } from '../openMeteo';

jest.mock('expo-notifications', () => ({}));

const NY = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday 9 Nov 2026, 7:40 AM in New York; Monday 7:30 AM; Sunday 8 Nov, 6 PM. */
const MON_740 = Date.UTC(2026, 10, 9, 12, 40);
const MON_730 = Date.UTC(2026, 10, 9, 12, 30);
const SUN_6PM = Date.UTC(2026, 10, 8, 23, 0);

const HOME = { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 40.7, lng: -74.0 };
const WORK = { id: 'work', kind: 'work', name: 'Work', address: '9 Pine St', area: '', lat: 40.75, lng: -73.98 };
const SCHOOL = { id: 'school', kind: 'school', name: 'School', address: '5 Elm St', area: '', lat: 40.71, lng: -74.01 };

let db: Db;
let n = 0;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set(PLACES_KEY, [HOME, WORK, SCHOOL]);
});

const trip = (over: Partial<NewTrip> & { started_at: number }) =>
  createTripsRepo(db).insert({ client_trip_id: `t${(n += 1)}`, ended_at: over.started_at + 20 * MIN, tz: NY, status: 'scored', ...over }, SUN_6PM);

/** The leg driven on 8 weekdays over 2 weeks at `minute` New York time, the last drive ending at its start (an evening drive home). */
async function seedLeg(from: typeof HOME, to: typeof HOME, minute: number) {
  const days = [
    ...[2, 3, 4, 5, 6].map((d) => Date.UTC(2026, 10, d, 5, 0)),
    ...[26, 27, 28].map((d) => Date.UTC(2026, 9, d, 4, 0)),
  ];
  for (const day of days) {
    await trip({ started_at: day + minute * MIN, from_place: from.id, to_place: to.id, start_lat: from.lat, start_lng: from.lng, end_lat: to.lat, end_lng: to.lng });
  }
}
async function endedAtHome() {
  await trip({ started_at: SUN_6PM - 2 * HOUR, from_place: null, to_place: 'home', start_lat: 40.8, start_lng: -74, end_lat: HOME.lat, end_lng: HOME.lng });
}

// ——— the forecast ———

const calm: Omit<WeatherSample, 'time'> = { code: 3, tempC: 4, rainMmH: 0, precipMmH: 0, snowCmH: 0, windMph: 5, gustMph: 9, visibilityM: 16000, isDay: true };
/** Hourly from Sunday 6 PM to Monday 6 PM; `bad` hours (UTC hour) carry freezing rain. */
function forecast(bad: (t: number) => boolean = () => false): HourlyForecast {
  const points = [];
  for (let t = SUN_6PM; t <= SUN_6PM + 24 * HOUR; t += HOUR) {
    points.push({ sample: { ...calm, time: t / 1000, ...(bad(t) ? { code: 66 } : {}) }, recentRainMm: 0, recentSnowCm: 0 });
  }
  return { points };
}
const icyMorning = forecast((t) => t >= MON_740 - HOUR && t <= MON_740 + HOUR);

// ——— the OS ———

function fakePort(granted = true) {
  const pending = new Map<string, { departAt: number | null; req?: HeadsUpRequest }>();
  const delivered = new Map<string, number | null>();
  /** When a shown one was due, when known. */
  const shownAt = new Map<string, number>();
  const log: string[] = [];
  const state = { granted };
  const port: HeadsUpPort = {
    permissionGranted: async () => state.granted,
    async schedule(req) {
      log.push(`schedule:${req.identifier}`);
      pending.set(req.identifier, { departAt: req.departAt, req });
    },
    async list() {
      const out: HeadsUpEntry[] = [];
      for (const [identifier, p] of pending) {
        out.push({ identifier, departAt: p.departAt, fireAt: p.req?.fireAt ?? null, delivered: false, ...(p.req ? { title: p.req.title, body: p.req.body } : {}) });
      }
      for (const [identifier, departAt] of delivered) out.push({ identifier, departAt, fireAt: shownAt.get(identifier) ?? null, delivered: true });
      return out;
    },
    async unschedule(id) {
      log.push(`unschedule:${id}`);
      pending.delete(id);
    },
    async dismiss(id) {
      log.push(`dismiss:${id}`);
      delivered.delete(id);
    },
  };
  /** The OS shows a pending one (its time came). */
  const deliver = (id: string) => {
    const p = pending.get(id);
    if (!p) throw new Error(`nothing pending: ${id}`);
    pending.delete(id);
    delivered.set(id, p.departAt);
    if (p.req) shownAt.set(id, p.req.fireAt);
  };
  return { port, pending, delivered, log, state, deliver };
}

const replan = (over: Partial<ReplanDeps> & Pick<ReplanDeps, 'port'>) =>
  replanHeadsUps({ db, now: () => SUN_6PM, tz: () => NY, forecast: async () => icyMorning, ...over });

describe('one plan', () => {
  it('schedules the heads-up half an hour before the usual departure when the forecast names a danger', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    const fetched: [number, number][] = [];
    expect(await replan({ port: p.port, forecast: async (lat, lng) => (fetched.push([lat, lng]), icyMorning) })).toBe('planned');
    expect(fetched).toEqual([[HOME.lat, HOME.lng]]);
    expect(p.pending.get('weather-commute:home-work')?.req).toEqual({
      identifier: 'weather-commute:home-work',
      title: 'Freezing rain',
      body: 'Expected around 7:40 AM, when you usually leave for work. Give yourself extra time.',
      fireAt: MON_740 - 30 * MIN,
      departAt: MON_740,
      leg: 'home-work',
    });
  });

  it('takes it back when the forecast clears', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    await replan({ port: p.port });
    expect(await replan({ port: p.port, forecast: async () => forecast() })).toBe('planned');
    expect(p.pending.size).toBe(0);
    expect(p.log).toEqual(['schedule:weather-commute:home-work', 'unschedule:weather-commute:home-work']);
  });

  it('a forecast that fails keeps the one for the same departure, and takes back one for another', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    await replan({ port: p.port });
    p.log.length = 0;
    expect(await replan({ port: p.port, forecast: async () => null })).toBe('partial');
    expect(p.pending.has('weather-commute:home-work')).toBe(true);
    expect(p.log).toEqual([]);
    // A thrown forecast is a failure too.
    expect(await replan({ port: p.port, forecast: async () => Promise.reject(new Error('offline')) })).toBe('partial');
    expect(p.pending.has('weather-commute:home-work')).toBe(true);
    // Scheduled for another departure (last week's plan): taken back.
    p.pending.set('weather-commute:home-work', { departAt: MON_740 - DAY });
    expect(await replan({ port: p.port, forecast: async () => null })).toBe('partial');
    expect(p.pending.size).toBe(0);
  });

  it('nothing without a learned leg, and a leftover one is taken back', async () => {
    const p = fakePort();
    p.pending.set('weather-commute:home-work', { departAt: MON_740 });
    p.pending.set('weather-commute:place-1-work', { departAt: MON_740 });
    const forecastSpy = jest.fn(async () => icyMorning);
    expect(await replan({ port: p.port, forecast: forecastSpy })).toBe('planned');
    expect(p.pending.size).toBe(0);
    expect(forecastSpy).not.toHaveBeenCalled();
  });

  it('none when the last drive ended away from the leg’s start', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await trip({ started_at: SUN_6PM - 2 * HOUR, to_place: null, end_lat: 41.2, end_lng: -73.5 });
    const p = fakePort();
    expect(await replan({ port: p.port })).toBe('planned');
    expect(p.pending.size).toBe(0);
  });

  it('switched off: every heads-up comes down, shown ones too', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    await createSettingsRepo(db).set(COMMUTE_HEADS_UP_KEY, false);
    const p = fakePort();
    p.pending.set('weather-commute:home-work', { departAt: MON_740 });
    p.delivered.set('weather-commute:work-home', SUN_6PM - HOUR);
    expect(await replan({ port: p.port })).toBe('off');
    expect(p.pending.size + p.delivered.size).toBe(0);
  });

  it('without notification permission: nothing is scheduled', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort(false);
    expect(await replan({ port: p.port })).toBe('denied');
    expect(p.log).toEqual([]);
  });

  it('a shown heads-up stays until an hour after its departure', async () => {
    const p = fakePort();
    p.delivered.set('weather-commute:home-work', SUN_6PM - 30 * MIN);
    p.delivered.set('weather-commute:home-school', SUN_6PM - 61 * MIN);
    p.delivered.set('weather-commute:work-home', null);
    await replan({ port: p.port });
    expect([...p.delivered.keys()]).toEqual(['weather-commute:home-work']);
  });

  it('two legs from home ten minutes apart: one forecast, one heads-up (the earlier departure)', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await seedLeg(HOME, SCHOOL, 7 * 60 + 30);
    await endedAtHome();
    const p = fakePort();
    const spy = jest.fn(async () => icyMorning);
    await replan({ port: p.port, forecast: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...p.pending.keys()]).toEqual(['weather-commute:home-school']);
    expect(p.pending.get('weather-commute:home-school')?.req?.fireAt).toBe(MON_730 - 30 * MIN);
  });

  it('one already shown counts for the spacing: Home → School shown at 7:00, nothing for Home → Work at 7:05', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await seedLeg(HOME, SCHOOL, 7 * 60 + 30);
    await endedAtHome();
    const p = fakePort();
    await replan({ port: p.port });
    expect([...p.pending.keys()]).toEqual(['weather-commute:home-school']);
    p.deliver('weather-commute:home-school');
    const mon705 = Date.UTC(2026, 10, 9, 12, 5);
    expect(await replan({ port: p.port, now: () => mon705 })).toBe('planned');
    expect(p.pending.size).toBe(0);
    expect(p.delivered.has('weather-commute:home-school')).toBe(true);
    // Without it, Home → Work would go at 7:10.
    p.delivered.clear();
    await replan({ port: p.port, now: () => mon705 });
    expect(p.pending.get('weather-commute:home-work')?.req?.fireAt).toBe(MON_740 - 30 * MIN);
  });

  it('a forecast that fails puts back the one a drive took down, for the same departure only', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    await replan({ port: p.port });
    const req = p.pending.get('weather-commute:home-work')?.req;
    const takenDown: HeadsUpEntry[] = (await p.port.list()).map((e) => e);
    p.pending.clear();
    expect(await replan({ port: p.port, forecast: async () => null, takenDown })).toBe('partial');
    expect(p.pending.get('weather-commute:home-work')?.req).toEqual(req);
    // For another departure: not put back.
    p.pending.clear();
    expect(await replan({ port: p.port, forecast: async () => null, takenDown: takenDown.map((e) => ({ ...e, departAt: MON_740 - DAY })) })).toBe('partial');
    expect(p.pending.size).toBe(0);
    // A forecast that answers decides, whatever was taken down.
    expect(await replan({ port: p.port, forecast: async () => forecast(), takenDown })).toBe('planned');
    expect(p.pending.size).toBe(0);
  });

  it('keeps to the quiet hours this phone holds, else the server’s default', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 20);
    await endedAtHome();
    const mon720 = Date.UTC(2026, 10, 9, 12, 20);
    const p = fakePort();
    // The default: 10 PM to 7 AM. 6:50 is quiet; 7:00 is 20 min before leaving.
    await replan({ port: p.port });
    expect(p.pending.get('weather-commute:home-work')?.req?.fireAt).toBe(Date.UTC(2026, 10, 9, 12, 0));
    // Quiet until 7:15: too close to 7:20, so none.
    await createSettingsRepo(db).set(QUIET_HOURS_KEY, { enabled: true, start: '22:00', end: '07:15' });
    await replan({ port: p.port });
    expect(p.pending.size).toBe(0);
    // Off: at 6:50.
    await createSettingsRepo(db).set(QUIET_HOURS_KEY, { enabled: false, start: '22:00', end: '07:15' });
    await replan({ port: p.port });
    expect(p.pending.get('weather-commute:home-work')?.req?.fireAt).toBe(mon720 - 30 * MIN);
  });

  it('a change that is no longer wanted writes nothing', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    expect(await replan({ port: p.port, stillWanted: () => false })).toBe('abandoned');
    expect(p.log).toEqual([]);
  });

  it('a heads-up whose time passed while it was planned is not sent', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    let clock = SUN_6PM;
    await replan({
      port: p.port,
      now: () => clock,
      forecast: async () => {
        clock = MON_740 - 29 * MIN;
        return icyMorning;
      },
    });
    expect(p.pending.size).toBe(0);
  });
});

describe('what the phone knows', () => {
  it('the kept drives of the last 42 days, and where the last of them ended', async () => {
    await trip({ started_at: SUN_6PM - 3 * DAY, from_place: 'home', to_place: 'work', end_lat: 1, end_lng: 2 });
    await trip({ started_at: SUN_6PM - 2 * DAY, status: 'not_driving', to_place: 'school' });
    await trip({ started_at: SUN_6PM - 1 * DAY, status: 'pending', to_place: 'home', end_lat: null, end_lng: null });
    await trip({ started_at: SUN_6PM - 1 * HOUR, status: 'recording' });
    await trip({ started_at: SUN_6PM - 43 * DAY });
    await trip({ started_at: SUN_6PM - 5 * DAY, archived_at: SUN_6PM });
    const { drives, last } = await readCommuteInputs(db, SUN_6PM);
    expect(drives.map((d) => d.startedAt)).toEqual([SUN_6PM - 3 * DAY, SUN_6PM - 1 * DAY]);
    expect(drives[0]).toMatchObject({ tz: NY, fromPlace: 'home', toPlace: 'work', end: { lat: 1, lng: 2 } });
    expect(last).toEqual({ toPlace: 'home', end: null });
  });

  it('nothing driven: no last drive', async () => {
    expect(await readCommuteInputs(db, SUN_6PM)).toEqual({ drives: [], last: null });
  });
});

// ——— the live planner ———

function fakeHost() {
  let snap = { status: 'idle', clientTripId: null, lastFinalized: null } as unknown as DriveState;
  const subs = new Set<(s: DriveState) => void>();
  return {
    host: {
      snapshot: () => snap,
      subscribe(fn: (s: DriveState) => void) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    } as unknown as Pick<DriveHost, 'subscribe' | 'snapshot'>,
    set(patch: Partial<DriveState>) {
      snap = { ...snap, ...patch };
      for (const f of [...subs]) f(snap);
    },
  };
}

function fakeAppState(state: string) {
  const subs = new Set<(s: string) => void>();
  return {
    currentState: state as string | null,
    addEventListener(_t: 'change', fn: (s: string) => void) {
      subs.add(fn);
      return { remove: () => subs.delete(fn) };
    },
    emit(next: string) {
      this.currentState = next;
      for (const f of [...subs]) f(next);
    },
  };
}

const finalized = (id: string, at: number, dropped: string | null = null) => ({ clientTripId: id, ok: true, status: 'scored', dropped, endCause: 'manual', at, durationS: 600, miles: 4, endedAt: at }) as never;

describe('the live planner', () => {
  let clock: number;
  beforeEach(async () => {
    clock = SUN_6PM;
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
  });

  const attach = (over: { host?: ReturnType<typeof fakeHost>; app?: ReturnType<typeof fakeAppState>; port?: ReturnType<typeof fakePort>; forecast?: () => Promise<HourlyForecast | null>; signedIn?: () => Promise<boolean> } = {}) => {
    const h = over.host ?? fakeHost();
    const app = over.app ?? fakeAppState('active');
    const p = over.port ?? fakePort();
    const forecastFn = jest.fn(over.forecast ?? (async () => icyMorning));
    const errors: string[] = [];
    const planner = attachCommuteHeadsUp(h.host, {
      db,
      port: p.port,
      appState: app,
      now: () => clock,
      tz: () => NY,
      forecast: forecastFn,
      ...(over.signedIn ? { signedIn: over.signedIn } : {}),
      onError: (_e, ctx) => errors.push(ctx),
    });
    return { h, app, p, forecastFn, planner, errors };
  };

  it('plans when RoadWise is in front, at most every 30 minutes', async () => {
    const t = attach();
    await t.planner.settled();
    expect(t.p.pending.has('weather-commute:home-work')).toBe(true);
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    t.app.emit('background');
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    clock += HEADS_UP_FOREGROUND_MS;
    t.app.emit('background');
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    expect(t.errors).toEqual([]);
    t.planner.detach();
  });

  it('after a failed forecast, tries again 5 minutes later', async () => {
    const t = attach({ forecast: async () => null });
    await t.planner.settled();
    clock += HEADS_UP_RETRY_MS - 1;
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    clock += 1;
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    t.planner.detach();
  });

  it('does not plan behind the driver’s back on a background launch', async () => {
    const t = attach({ app: fakeAppState('background') });
    await t.planner.settled();
    expect(t.forecastFn).not.toHaveBeenCalled();
    t.planner.detach();
  });

  it('a drive that starts takes every heads-up down; nothing is planned while it records', async () => {
    const t = attach();
    await t.planner.settled();
    t.p.delivered.set('weather-commute:work-home', clock);
    t.h.set({ status: 'recording', clientTripId: 'd1' } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.p.pending.size + t.p.delivered.size).toBe(0);
    clock += HEADS_UP_FOREGROUND_MS;
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    expect(t.p.pending.size).toBe(0);
    t.planner.detach();
  });

  it('a drive taken in at the launch takes them down too', async () => {
    const h = fakeHost();
    h.set({ status: 'recording', clientTripId: 'adopted' } as Partial<DriveState>);
    const p = fakePort();
    p.pending.set('weather-commute:home-work', { departAt: MON_740 });
    const t = attach({ host: h, port: p });
    await t.planner.settled();
    expect(p.pending.size).toBe(0);
    expect(t.forecastFn).not.toHaveBeenCalled();
    t.planner.detach();
  });

  it('a drive starting while the forecast is out: the plan schedules nothing', async () => {
    let answer: (f: HourlyForecast) => void = () => {};
    const t = attach({ forecast: () => new Promise((resolve) => (answer = resolve)) });
    while (t.forecastFn.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 0));
    t.h.set({ status: 'recording', clientTripId: 'd1' } as Partial<DriveState>);
    answer(icyMorning);
    await t.planner.settled();
    expect(t.p.pending.size).toBe(0);
    expect(t.p.log.filter((l) => l.startsWith('schedule'))).toEqual([]);
    t.planner.detach();
  });

  it('plans again once a drive has closed, past the throttle, in the background too', async () => {
    const app = fakeAppState('background');
    const t = attach({ app });
    t.h.set({ status: 'recording', clientTripId: 'd1' } as Partial<DriveState>);
    t.h.set({ status: 'finalizing', lastFinalized: finalized('d1', clock) } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).not.toHaveBeenCalled();
    t.h.set({ status: 'idle', clientTripId: null } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    expect(t.p.pending.has('weather-commute:home-work')).toBe(true);
    // A drive not kept (it never moved) plans again as well.
    t.h.set({ status: 'recording', clientTripId: 'd2' } as Partial<DriveState>);
    t.h.set({ status: 'idle', clientTripId: null, lastFinalized: finalized('d2', clock + 1, 'no_movement') } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    expect(t.p.pending.has('weather-commute:home-work')).toBe(true);
    t.planner.detach();
  });

  it('a passenger’s "Not driving?" puts the heads-ups back, the front that came mid-drive past the throttle', async () => {
    const t = attach();
    await t.planner.settled();
    expect(t.p.pending.has('weather-commute:home-work')).toBe(true);
    // 18:10 a ride starts on its own; 18:12 the passenger opens RoadWise (it records) and taps "Not driving?".
    clock += 10 * MIN;
    t.h.set({ status: 'recording', clientTripId: 'd1' } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.p.pending.size).toBe(0);
    clock += 2 * MIN;
    t.app.emit('background');
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    t.h.set({ status: 'idle', clientTripId: null, lastFinalized: finalized('d1', clock, 'cancelled') } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    expect(t.p.pending.has('weather-commute:home-work')).toBe(true);
    t.planner.detach();
  });

  it('a front while a drive is open (not recording) plans once it closes', async () => {
    const t = attach();
    await t.planner.settled();
    t.h.set({ status: 'finalizing' } as Partial<DriveState>);
    clock += HEADS_UP_FOREGROUND_MS;
    t.app.emit('background');
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    t.h.set({ status: 'idle' } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    t.planner.detach();
  });

  it('the plan after a drive puts back what the drive took down when the forecast fails there', async () => {
    let answer: HourlyForecast | null = icyMorning;
    const t = attach({ forecast: async () => answer });
    await t.planner.settled();
    const req = t.p.pending.get('weather-commute:home-work')?.req;
    expect(req).toBeDefined();
    clock += HOUR;
    t.h.set({ status: 'recording', clientTripId: 'd1' } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.p.pending.size).toBe(0);
    // It ends in a garage: no forecast.
    answer = null;
    clock += 20 * MIN;
    t.h.set({ status: 'idle', clientTripId: null, lastFinalized: finalized('d1', clock) } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    expect(t.p.pending.get('weather-commute:home-work')?.req).toEqual(req);
    // Switched off: what was taken down is forgotten.
    t.h.set({ status: 'recording', clientTripId: 'd2' } as Partial<DriveState>);
    await t.planner.settled();
    await t.planner.cancelAll();
    t.h.set({ status: 'idle', clientTripId: null, lastFinalized: finalized('d2', clock + 1) } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.p.pending.size).toBe(0);
    t.planner.detach();
  });

  it('without permission, then granted: the next front plans at once', async () => {
    const p = fakePort();
    const t = attach({ port: p });
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(1);
    p.state.granted = false;
    clock += HEADS_UP_FOREGROUND_MS;
    t.app.emit('background');
    t.app.emit('active');
    await t.planner.settled();
    expect(p.pending.size).toBe(0);
    p.state.granted = true;
    clock += MIN;
    t.app.emit('background');
    t.app.emit('active');
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    expect(p.pending.has('weather-commute:home-work')).toBe(true);
    t.planner.detach();
  });

  it('signed out: nothing is planned, and what is left comes down', async () => {
    const p = fakePort();
    p.pending.set('weather-commute:home-work', { departAt: MON_740 });
    const t = attach({ port: p, signedIn: async () => false });
    await t.planner.settled();
    expect(p.pending.size).toBe(0);
    expect(t.forecastFn).not.toHaveBeenCalled();
    t.planner.detach();
  });

  it('a session that cannot be read plans as before', async () => {
    const t = attach({ signedIn: async () => Promise.reject(new Error('offline')) });
    await t.planner.settled();
    expect(t.p.pending.has('weather-commute:home-work')).toBe(true);
    t.planner.detach();
  });

  it('the switch: off takes them down through the live planner, on plans past the throttle', async () => {
    const t = attach();
    await t.planner.settled();
    expect(t.p.pending.size).toBe(1);
    await cancelCommuteHeadsUps();
    expect(t.p.pending.size).toBe(0);
    requestCommuteReplan();
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
    expect(t.p.pending.size).toBe(1);
    t.planner.detach();
    // Detached: a wipe reaches the OS straight.
    const other = fakePort();
    other.pending.set('weather-commute:home-work', { departAt: MON_740 });
    await cancelCommuteHeadsUps(other.port);
    expect(other.pending.size).toBe(0);
    requestCommuteReplan();
    await t.planner.settled();
    expect(t.forecastFn).toHaveBeenCalledTimes(2);
  });

  it('a take-down never rejects, even when the OS fails', async () => {
    const broken: HeadsUpPort = {
      permissionGranted: async () => true,
      schedule: async () => {},
      list: async () => Promise.reject(new Error('E_NOTIF')),
      unschedule: async () => {},
      dismiss: async () => {},
    };
    await expect(cancelCommuteHeadsUps(broken)).resolves.toBeUndefined();
  });

  it('detached: nothing more is planned', async () => {
    const t = attach({ app: fakeAppState('background') });
    t.planner.detach();
    t.app.emit('active');
    t.h.set({ status: 'idle', lastFinalized: finalized('d1', clock) } as Partial<DriveState>);
    await t.planner.settled();
    expect(t.forecastFn).not.toHaveBeenCalled();
  });
});

describe('the lazy take-down', () => {
  it('reaches the live planner without loading the notifications module at import', async () => {
    const { cancelCommuteHeadsUpsLazily } = jest.requireActual<typeof import('../cancelHeadsUps')>('../cancelHeadsUps');
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    const h = fakeHost();
    const planner = attachCommuteHeadsUp(h.host, { db, port: p.port, appState: fakeAppState('active'), now: () => SUN_6PM, tz: () => NY, forecast: async () => icyMorning });
    await planner.settled();
    expect(p.pending.size).toBe(1);
    await cancelCommuteHeadsUpsLazily();
    expect(p.pending.size).toBe(0);
    planner.detach();
  });

  it('plans again past the throttle when asked (the places or the quiet hours changed)', async () => {
    const { requestCommuteReplanLazily } = jest.requireActual<typeof import('../cancelHeadsUps')>('../cancelHeadsUps');
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    const spy = jest.fn(async () => icyMorning);
    const planner = attachCommuteHeadsUp(fakeHost().host, { db, port: p.port, appState: fakeAppState('active'), now: () => SUN_6PM, tz: () => NY, forecast: spy });
    await planner.settled();
    expect(spy).toHaveBeenCalledTimes(1);
    // Work removed: its heads-up goes at once.
    await createSettingsRepo(db).set(PLACES_KEY, [HOME, SCHOOL]);
    requestCommuteReplanLazily();
    await planner.settled();
    expect(p.pending.size).toBe(0);
    planner.detach();
  });
});

describe('a drive with no id yet', () => {
  it('still takes the heads-ups down, once', async () => {
    await seedLeg(HOME, WORK, 7 * 60 + 40);
    await endedAtHome();
    const p = fakePort();
    const h = fakeHost();
    const planner = attachCommuteHeadsUp(h.host, { db, port: p.port, appState: fakeAppState('background'), now: () => SUN_6PM, tz: () => NY, forecast: async () => icyMorning });
    p.pending.set('weather-commute:home-work', { departAt: MON_740 });
    h.set({ status: 'recording', clientTripId: null } as Partial<DriveState>);
    await planner.settled();
    expect(p.pending.size).toBe(0);
    h.set({ status: 'recording', clientTripId: null } as Partial<DriveState>);
    await planner.settled();
    expect(p.log.filter((l) => l.startsWith('unschedule'))).toHaveLength(1);
    planner.detach();
  });
});
