/** @jest-environment node */
import { CONSTANTS } from '@scoring';
import { seq, T0 } from '@/core/detectors/__fixtures__/rows';
import {
  HABITUAL_MIN_CONFIRMATIONS,
  forgetRoleAnswer,
  ROLE_ANSWER_KEY_PREFIX,
  roleAnswerKey,
  ROLE_PRIOR_KEY,
  ROLE_ROUTES_KEY,
  ROLE_ROUTES_MAX,
  isHabitualDriverRoute,
  longestHandlingRunMinutes,
  readRolePrior,
  recordRoleAnswer,
  routeKey,
} from '@/core/engine/rolePrior';
import type { DetectedEvent, FeatureRow } from '@/core/engine/types';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

describe('the keys and constants (brief values)', () => {
  test('are exactly the brief values', () => {
    expect(ROLE_PRIOR_KEY).toBe('role.prior');
    expect(ROLE_ROUTES_KEY).toBe('role.routes');
    expect(HABITUAL_MIN_CONFIRMATIONS).toBe(2);
    expect(ROLE_ROUTES_MAX).toBe(200);
  });
});

describe('routeKey', () => {
  test('is the same whichever way the route is driven', () => {
    expect(routeKey('9q8yy', 'c23nb')).toBe(routeKey('c23nb', '9q8yy'));
  });

  test('tells different pairs apart', () => {
    expect(routeKey('9q8yy', 'c23nb')).not.toBe(routeKey('9q8yy', 'c23nc'));
    expect(routeKey('9q8yy', '9q8yy')).not.toBe(routeKey('9q8yy', 'c23nb'));
  });
});

describe('the per-user prior: (driverAnswers + 1) / (answers + 2)', () => {
  test('is neutral with no answers', async () => {
    await expect(readRolePrior(db)).resolves.toBe(0.5);
  });

  test('follows the stored counts', async () => {
    await createSettingsRepo(db).set(ROLE_PRIOR_KEY, { driverAnswers: 7, answers: 8 });
    await expect(readRolePrior(db)).resolves.toBeCloseTo(0.8);
    await createSettingsRepo(db).set(ROLE_PRIOR_KEY, { driverAnswers: 0, answers: 3 });
    await expect(readRolePrior(db)).resolves.toBeCloseTo(0.2);
  });

  test('a damaged value reads as neutral rather than failing the finalize', async () => {
    await createSettingsRepo(db).set(ROLE_PRIOR_KEY, { driverAnswers: 9, answers: 2 });
    await expect(readRolePrior(db)).resolves.toBe(0.5);
    await createSettingsRepo(db).set(ROLE_PRIOR_KEY, 'nonsense');
    await expect(readRolePrior(db)).resolves.toBe(0.5);
  });
});

describe('recordRoleAnswer updates the prior and the route', () => {
  const route = { start: '9q8yy', end: 'c23nb' };

  test('a driver answer counts toward both', async () => {
    await recordRoleAnswer(db, 'driver', route);
    const settings = createSettingsRepo(db);
    await expect(settings.get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings.get(ROLE_ROUTES_KEY)).resolves.toEqual({
      [routeKey('9q8yy', 'c23nb')]: { driver: 1, other: 0 },
    });
    await expect(readRolePrior(db)).resolves.toBeCloseTo(2 / 3);
  });

  test('passenger and transit answers both count as not driving', async () => {
    await recordRoleAnswer(db, 'passenger', route);
    await recordRoleAnswer(db, 'other', { start: 'c23nb', end: '9q8yy' });
    const settings = createSettingsRepo(db);
    await expect(settings.get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 0, answers: 2 });
    await expect(settings.get(ROLE_ROUTES_KEY)).resolves.toEqual({
      [routeKey('9q8yy', 'c23nb')]: { driver: 0, other: 2 },
    });
    await expect(readRolePrior(db)).resolves.toBeCloseTo(0.25);
  });

  test('a trip with no geohash updates the prior only', async () => {
    await recordRoleAnswer(db, 'driver', { start: null, end: 'c23nb' });
    const settings = createSettingsRepo(db);
    await expect(settings.get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings.get(ROLE_ROUTES_KEY)).resolves.toBeNull();
  });

  test('keeps at most 200 routes, dropping the one answered longest ago', async () => {
    const cell = (i: number) => `s${String(i).padStart(4, '0')}`;
    for (let i = 0; i < ROLE_ROUTES_MAX; i += 1) {
      await recordRoleAnswer(db, 'driver', { start: cell(i), end: 'zzzzz' });
    }
    // Route 0 is answered again, so route 1 is now the oldest.
    await recordRoleAnswer(db, 'driver', { start: cell(0), end: 'zzzzz' });
    await recordRoleAnswer(db, 'driver', { start: cell(ROLE_ROUTES_MAX), end: 'zzzzz' });

    const routes = (await createSettingsRepo(db).get<Record<string, unknown>>(ROLE_ROUTES_KEY)) ?? {};
    expect(Object.keys(routes)).toHaveLength(ROLE_ROUTES_MAX);
    expect(routes[routeKey(cell(1), 'zzzzz')]).toBeUndefined();
    expect(routes[routeKey(cell(0), 'zzzzz')]).toEqual({ driver: 2, other: 0 });
    expect(routes[routeKey(cell(ROLE_ROUTES_MAX), 'zzzzz')]).toEqual({ driver: 1, other: 0 });
  });
});

describe('one trip counts once: its counted answer is kept and a changed answer replaces it (E2 fix round 1)', () => {
  const route = { start: '9q8yy', end: 'c23nb' };
  const KEY = routeKey('9q8yy', 'c23nb');
  const settings = () => createSettingsRepo(db);

  test('the record is keyed by trip id', () => {
    expect(ROLE_ANSWER_KEY_PREFIX).toBe('role.answer.');
    expect(roleAnswerKey('trip-1')).toBe('role.answer.trip-1');
  });

  test('passenger then driver leaves the prior and the route as if only driver had been answered', async () => {
    await recordRoleAnswer(db, 'passenger', route, 'trip-1');
    await recordRoleAnswer(db, 'driver', route, 'trip-1');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 1, other: 0 } });
    await expect(settings().get(roleAnswerKey('trip-1'))).resolves.toEqual({ drove: true, route: KEY });
  });

  test('driver then passenger reverses the same way', async () => {
    await recordRoleAnswer(db, 'driver', route, 'trip-1');
    await recordRoleAnswer(db, 'passenger', route, 'trip-1');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 0, answers: 1 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 0, other: 1 } });
  });

  test('driver then driver counts once, in the prior and on the route', async () => {
    await recordRoleAnswer(db, 'driver', route, 'trip-1');
    await recordRoleAnswer(db, 'driver', route, 'trip-1');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 1, other: 0 } });
    await expect(isHabitualDriverRoute(db, route.start, route.end)).resolves.toBe(false);
  });

  test('passenger then transit is the same "not driving" answer: counted once', async () => {
    await recordRoleAnswer(db, 'passenger', route, 'trip-1');
    await recordRoleAnswer(db, 'other', route, 'trip-1');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 0, answers: 1 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 0, other: 1 } });
  });

  test('negative control: the same answers on different trips all count', async () => {
    await recordRoleAnswer(db, 'passenger', route, 'trip-1');
    await recordRoleAnswer(db, 'driver', route, 'trip-2');
    await recordRoleAnswer(db, 'driver', route, 'trip-3');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 2, answers: 3 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 2, other: 1 } });
    await expect(isHabitualDriverRoute(db, route.start, route.end)).resolves.toBe(true);
  });

  test('a flip-flopping answer on one trip never makes a route habitual', async () => {
    for (const role of ['driver', 'passenger', 'driver', 'passenger', 'driver'] as const) {
      await recordRoleAnswer(db, role, route, 'trip-1');
    }
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(isHabitualDriverRoute(db, route.start, route.end)).resolves.toBe(false);
  });

  test('a change on a trip whose route has since been evicted still corrects the prior', async () => {
    await recordRoleAnswer(db, 'passenger', route, 'trip-1');
    await settings().set(ROLE_ROUTES_KEY, {});
    await recordRoleAnswer(db, 'driver', route, 'trip-1');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 1, other: 0 } });
  });

  test('a trip with no geohash is recorded with no route and changes only the prior', async () => {
    await recordRoleAnswer(db, 'passenger', { start: null, end: null }, 'trip-1');
    await recordRoleAnswer(db, 'driver', { start: null, end: null }, 'trip-1');
    await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
    await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toBeNull();
    await expect(settings().get(roleAnswerKey('trip-1'))).resolves.toEqual({ drove: true, route: null });
  });

  describe('forgetRoleAnswer (a trip deleted locally)', () => {
    test('removes the record and what it counted, dropping a route left with no answers', async () => {
      await recordRoleAnswer(db, 'driver', route, 'trip-1');
      await recordRoleAnswer(db, 'driver', { start: 'aaaaa', end: 'bbbbb' }, 'trip-2');
      await forgetRoleAnswer(db, 'trip-1');
      await expect(settings().get(roleAnswerKey('trip-1'))).resolves.toBeNull();
      await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
      await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({
        [routeKey('aaaaa', 'bbbbb')]: { driver: 1, other: 0 },
      });
    });

    test('is a no-op for a trip never answered', async () => {
      await recordRoleAnswer(db, 'driver', route, 'trip-1');
      await forgetRoleAnswer(db, 'trip-9');
      await expect(settings().get(ROLE_PRIOR_KEY)).resolves.toEqual({ driverAnswers: 1, answers: 1 });
      await expect(settings().get(ROLE_ROUTES_KEY)).resolves.toEqual({ [KEY]: { driver: 1, other: 0 } });
    });
  });
});

describe('isHabitualDriverRoute: driver ≥ 2 and driver > other', () => {
  const start = '9q8yy';
  const end = 'c23nb';

  test('one driver confirmation is not enough; two are, in either direction', async () => {
    await recordRoleAnswer(db, 'driver', { start, end });
    await expect(isHabitualDriverRoute(db, start, end)).resolves.toBe(false);
    await recordRoleAnswer(db, 'driver', { start: end, end: start });
    await expect(isHabitualDriverRoute(db, start, end)).resolves.toBe(true);
    await expect(isHabitualDriverRoute(db, end, start)).resolves.toBe(true);
  });

  test('a route as often driven by someone else is not habitual', async () => {
    await recordRoleAnswer(db, 'driver', { start, end });
    await recordRoleAnswer(db, 'driver', { start, end });
    await recordRoleAnswer(db, 'passenger', { start, end });
    await recordRoleAnswer(db, 'passenger', { start, end });
    await expect(isHabitualDriverRoute(db, start, end)).resolves.toBe(false);
    await recordRoleAnswer(db, 'driver', { start, end });
    await expect(isHabitualDriverRoute(db, start, end)).resolves.toBe(true);
  });

  test('an unknown end, or a route never answered, is not habitual', async () => {
    await recordRoleAnswer(db, 'driver', { start, end });
    await recordRoleAnswer(db, 'driver', { start, end });
    await expect(isHabitualDriverRoute(db, null, end)).resolves.toBe(false);
    await expect(isHabitualDriverRoute(db, start, null)).resolves.toBe(false);
    await expect(isHabitualDriverRoute(db, start, 'zzzzz')).resolves.toBe(false);
  });
});

describe('longestHandlingRunMinutes: one continuous run, never a sum', () => {
  const MOVING = CONSTANTS.LOCKOUT_SPEED_MPS + 5;
  const handling: Partial<FeatureRow> = { handlingScore: 0.8, screenOn: true, locked: false, speed: MOVING };
  const idle: Partial<FeatureRow> = { handlingScore: 0, screenOn: false, locked: true, speed: MOVING };

  const harsh = (startedAt: number, category: DetectedEvent['category'] = 'braking'): DetectedEvent => ({
    id: `h-${startedAt}`,
    category,
    startedAt,
    durationS: 1,
    q: 0.8,
    corrected: false,
    status: 'scored',
    measured: { peakG: 0.45 },
    context: { night: false, precipitation: false },
    alertable: true,
    source: 'both',
  });

  test('one 4-minute run is 4 minutes', () => {
    expect(longestHandlingRunMinutes(seq([60, idle], [240, handling], [60, idle]), [])).toBe(4);
  });

  test('three separate 1-minute runs are 1 minute, not 3', () => {
    const rows = seq([60, handling], [30, idle], [60, handling], [30, idle], [60, handling]);
    expect(longestHandlingRunMinutes(rows, [])).toBe(1);
  });

  test('a row below the handling threshold, with the screen off, or locked breaks the run', () => {
    for (const breaker of [
      { ...handling, handlingScore: 0.59 },
      { ...handling, screenOn: false },
      { ...handling, locked: true },
    ]) {
      expect(longestHandlingRunMinutes(seq([120, handling], [1, breaker], [60, handling]), [])).toBe(2);
    }
  });

  test('only handling at moving speed counts; an unknown speed breaks the run', () => {
    const stopped = { ...handling, speed: 0 };
    expect(longestHandlingRunMinutes(seq([300, stopped]), [])).toBe(0);
    const noFix = { ...handling, gnssValid: false };
    expect(longestHandlingRunMinutes(seq([60, handling], [1, noFix], [60, handling]), [])).toBe(1);
  });

  test('a harsh event inside the stretch splits it; a phone event does not', () => {
    const rows = seq([240, handling]);
    // Row 120 carries the brake: rows 0–119 (2 min) and 121–239 remain.
    expect(longestHandlingRunMinutes(rows, [harsh(T0 + 120_000)])).toBe(2);
    expect(longestHandlingRunMinutes(rows, [harsh(T0 + 120_000, 'cornering')])).toBe(2);
    const phone = { ...harsh(T0 + 120_000, 'phone'), measured: { speedMps: MOVING } };
    expect(longestHandlingRunMinutes(rows, [phone])).toBe(4);
  });

  test('missing rows break the run', () => {
    const rows = [...seq([120, handling]), ...seq([120, handling]).map((r) => ({ ...r, ts: r.ts + 600_000 }))];
    expect(longestHandlingRunMinutes(rows, [])).toBe(2);
  });

  test('no rows is zero', () => {
    expect(longestHandlingRunMinutes([], [])).toBe(0);
  });
});
