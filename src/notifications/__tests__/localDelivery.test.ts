import { buildCatalog, NOTIFICATION_CATEGORIES, type NotificationCategory } from '@/notifications/catalog';
import { LOCAL_SENT_KEY, PREFS_CACHE_KEY } from '@/notifications/keys';
import {
  effectivePrefs,
  LOCAL_LEDGER_KEY,
  localDeliveryPlan,
  readCachedPrefs,
  readLocalCounts,
  readLocalSent,
  recordLocalSent,
  SUMMARY_DELAY_MS,
  uncountLocalSent,
  writePrefsCache,
  type EffectivePrefs,
  type PlanInput,
} from '@/notifications/localDelivery';

const LA = 'America/Los_Angeles';
const MIN = 60_000;

/** An in-memory settings repo with the two calls these functions use. */
function memorySettings(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, JSON.stringify(value));
    },
    peek: (key: string): unknown => {
      const raw = store.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

const allOn = (): Record<NotificationCategory, boolean> =>
  Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])) as Record<NotificationCategory, boolean>;

const prefs = (over: Partial<EffectivePrefs> = {}): EffectivePrefs => ({
  categories: allOn(),
  quiet: { enabled: true, start: '22:00', end: '07:00' },
  ...over,
});

/** 14:00 PDT on 2026-09-22 (21:00Z): well outside quiet hours. */
const AFTERNOON = Date.parse('2026-09-22T21:00:00Z');

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  type: 'trip_summary',
  endedAt: AFTERNOON,
  now: AFTERNOON,
  prefs: prefs(),
  tz: LA,
  localSentToday: 0,
  serverPushedToday: 0,
  ...over,
});

describe('localDeliveryPlan', () => {
  it('skips when the category is off', () => {
    const categories = { ...allOn(), trip_summaries: false };
    expect(localDeliveryPlan(input({ prefs: prefs({ categories }) }))).toEqual({
      kind: 'skip',
      reason: 'category_off',
    });
  });

  it('another category being off does not matter', () => {
    const categories = { ...allOn(), recording: false };
    expect(localDeliveryPlan(input({ prefs: prefs({ categories }) })).kind).toBe('schedule');
  });

  it('is capped by 2 local notifications today', () => {
    expect(localDeliveryPlan(input({ localSentToday: 2 }))).toEqual({ kind: 'skip', reason: 'capped' });
  });

  it('is capped by 1 local and 1 pushed today — one number for both', () => {
    expect(localDeliveryPlan(input({ localSentToday: 1, serverPushedToday: 1 }))).toEqual({
      kind: 'skip',
      reason: 'capped',
    });
  });

  it('is not capped by 1 in total', () => {
    expect(localDeliveryPlan(input({ localSentToday: 1 })).kind).toBe('schedule');
    expect(localDeliveryPlan(input({ serverPushedToday: 1 })).kind).toBe('schedule');
  });

  it('targets endedAt + 120 s', () => {
    expect(SUMMARY_DELAY_MS).toBe(120_000);
    expect(localDeliveryPlan(input())).toEqual({ kind: 'schedule', at: AFTERNOON + 120_000 });
  });

  it('never targets the past: a finalize long after the end schedules now', () => {
    const now = AFTERNOON + 10 * MIN;
    expect(localDeliveryPlan(input({ now }))).toEqual({ kind: 'schedule', at: now });
  });

  it('a drive ending 23:50 local with quiet hours 22:00–07:00 → 07:00 local the next day', () => {
    const endedAt = Date.parse('2026-09-23T06:50:00Z'); // 23:50 PDT on the 22nd
    const plan = localDeliveryPlan(input({ endedAt, now: endedAt }));
    expect(plan).toEqual({ kind: 'schedule', at: Date.parse('2026-09-23T14:00:00Z') }); // 07:00 PDT
  });

  it('a target inside quiet hours after midnight → 07:00 the same morning', () => {
    const endedAt = Date.parse('2026-09-23T09:00:00Z'); // 02:00 PDT
    expect(localDeliveryPlan(input({ endedAt, now: endedAt }))).toEqual({
      kind: 'schedule',
      at: Date.parse('2026-09-23T14:00:00Z'),
    });
  });

  it('06:58 + 2 min lands exactly on 07:00, which is outside quiet hours (end exclusive)', () => {
    const endedAt = Date.parse('2026-09-23T13:58:00Z'); // 06:58 PDT
    expect(localDeliveryPlan(input({ endedAt, now: endedAt }))).toEqual({
      kind: 'schedule',
      at: Date.parse('2026-09-23T14:00:00Z'),
    });
  });

  it('21:57 + 2 min is 21:59: sent before quiet hours start', () => {
    const endedAt = Date.parse('2026-09-23T04:57:00Z'); // 21:57 PDT on the 22nd
    expect(localDeliveryPlan(input({ endedAt, now: endedAt }))).toEqual({
      kind: 'schedule',
      at: endedAt + 120_000,
    });
  });

  it('DST end (fall back): 23:30 PDT on 2026-10-31 → 07:00 PST on 11-01 (15:00Z)', () => {
    const endedAt = Date.parse('2026-11-01T06:30:00Z');
    expect(localDeliveryPlan(input({ endedAt, now: endedAt }))).toEqual({
      kind: 'schedule',
      at: Date.parse('2026-11-01T15:00:00Z'),
    });
  });

  it('DST start (spring forward): 23:30 PST on 2027-03-13 → 07:00 PDT on 03-14 (14:00Z)', () => {
    const endedAt = Date.parse('2027-03-14T07:30:00Z');
    expect(localDeliveryPlan(input({ endedAt, now: endedAt }))).toEqual({
      kind: 'schedule',
      at: Date.parse('2027-03-14T14:00:00Z'),
    });
  });

  it('a quiet end inside the spring-forward gap resolves just past the gap, never before it', () => {
    const endedAt = Date.parse('2027-03-14T08:30:00Z'); // 00:30 PST on 03-14
    const quiet = { enabled: true, start: '22:00', end: '02:30' }; // 02:30 does not exist that night
    const plan = localDeliveryPlan(input({ endedAt, now: endedAt, prefs: prefs({ quiet }) }));
    expect(plan).toEqual({ kind: 'schedule', at: Date.parse('2027-03-14T10:30:00Z') }); // 03:30 PDT
  });

  it('start = end means quiet hours are off', () => {
    const endedAt = Date.parse('2026-09-23T06:50:00Z'); // 23:50 PDT
    const quiet = { enabled: true, start: '22:00', end: '22:00' };
    expect(localDeliveryPlan(input({ endedAt, now: endedAt, prefs: prefs({ quiet }) }))).toEqual({
      kind: 'schedule',
      at: endedAt + 120_000,
    });
  });

  it('quiet hours disabled means no deferral', () => {
    const endedAt = Date.parse('2026-09-23T06:50:00Z');
    const quiet = { enabled: false, start: '22:00', end: '07:00' };
    expect(localDeliveryPlan(input({ endedAt, now: endedAt, prefs: prefs({ quiet }) }))).toEqual({
      kind: 'schedule',
      at: endedAt + 120_000,
    });
  });

  it('quiet hours are read in the given zone (Paris)', () => {
    const endedAt = Date.parse('2026-09-22T21:00:00Z'); // 23:00 CEST
    expect(localDeliveryPlan(input({ endedAt, now: endedAt, tz: 'Europe/Paris' }))).toEqual({
      kind: 'schedule',
      at: Date.parse('2026-09-23T05:00:00Z'), // 07:00 CEST
    });
  });

  it('an unknown zone is normalised (UTC), never a throw', () => {
    const endedAt = Date.parse('2026-09-22T12:00:00Z');
    expect(localDeliveryPlan(input({ endedAt, now: endedAt, tz: 'Not/AZone' }))).toEqual({
      kind: 'schedule',
      at: endedAt + 120_000,
    });
  });

  describe('N-I1: a notification counts on the day it is delivered', () => {
    it('two summaries today, a drive ending 23:50 → deferred to tomorrow 07:00, not capped', () => {
      const endedAt = Date.parse('2026-09-23T06:50:00Z');
      const plan = localDeliveryPlan(
        input({ endedAt, now: endedAt, localSentToday: 2, serverPushedToday: 1 })
      );
      expect(plan).toEqual({ kind: 'schedule', at: Date.parse('2026-09-23T14:00:00Z') });
    });

    it('a deferred delivery is capped by what is already scheduled for that day', () => {
      const endedAt = Date.parse('2026-09-23T06:50:00Z');
      const plan = localDeliveryPlan(
        input({ endedAt, now: endedAt, localScheduledByDay: { '2026-09-23': 2 } })
      );
      expect(plan).toEqual({ kind: 'skip', reason: 'capped' });
    });
  });

  it('with drive summaries transactional (buildCatalog(false)) a summary is never capped', () => {
    const plan = localDeliveryPlan(
      input({ localSentToday: 5, serverPushedToday: 5, catalog: buildCatalog(false) })
    );
    expect(plan).toEqual({ kind: 'schedule', at: AFTERNOON + 120_000 });
  });

  it('a category off still wins with buildCatalog(false)', () => {
    const categories = { ...allOn(), trip_summaries: false };
    expect(
      localDeliveryPlan(input({ prefs: prefs({ categories }), catalog: buildCatalog(false) }))
    ).toEqual({ kind: 'skip', reason: 'category_off' });
  });
});

describe('the local count (LOCAL_SENT_KEY)', () => {
  const DAY1_2359 = Date.parse('2026-09-23T06:59:00Z'); // 23:59 PDT on 09-22
  const DAY2_0001 = Date.parse('2026-09-23T07:01:00Z'); // 00:01 PDT on 09-23

  it('records a shown notification and writes { day, count } exactly', async () => {
    const s = memorySettings();
    expect(await recordLocalSent(s, LA, AFTERNOON)).toBe(1);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 1 });
    expect(await recordLocalSent(s, LA, AFTERNOON + MIN)).toBe(2);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 2 });
    expect(await readLocalSent(s, LA, AFTERNOON + 2 * MIN)).toEqual({ day: '2026-09-22', count: 2 });
  });

  it('resets at local midnight', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, DAY1_2359 - MIN);
    expect(await recordLocalSent(s, LA, DAY1_2359)).toBe(2);
    expect(await recordLocalSent(s, LA, DAY2_0001)).toBe(1);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-23', count: 1 });
  });

  it('reading after midnight rolls the exported key to the new day', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, DAY1_2359);
    expect(await readLocalSent(s, LA, DAY2_0001)).toEqual({ day: '2026-09-23', count: 0 });
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-23', count: 0 });
  });

  it('the day is the local day in the normalised zone (GMT+5 → Etc/GMT-5)', async () => {
    const s = memorySettings();
    const t = Date.parse('2026-09-22T20:00:00Z'); // 01:00 on the 23rd at UTC+5
    await recordLocalSent(s, 'GMT+5', t);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-23', count: 1 });
  });

  it('a delivery scheduled for tomorrow counts tomorrow, not today (N-I1)', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON);
    await recordLocalSent(s, LA, AFTERNOON + MIN);
    const now = Date.parse('2026-09-23T06:52:00Z'); // 23:52 PDT
    const at = Date.parse('2026-09-23T14:00:00Z'); // 07:00 PDT tomorrow
    expect(await recordLocalSent(s, LA, now, { id: 'drive-summary:b', at })).toBe(1);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 2 });
    expect(await readLocalCounts(s, LA, now)).toEqual({
      today: { day: '2026-09-22', count: 2 },
      byDay: { '2026-09-22': 2, '2026-09-23': 1 },
    });
    // At 07:30 tomorrow it has been delivered: it is tomorrow's first, with nothing else recorded.
    const later = Date.parse('2026-09-23T14:30:00Z');
    expect(await readLocalSent(s, LA, later)).toEqual({ day: '2026-09-23', count: 1 });
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-23', count: 1 });
  });

  it('a notification cancelled before delivery is uncounted (N-I1)', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON, { id: 'drive-summary:a', at: AFTERNOON + 2 * MIN });
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 1 });
    expect(await uncountLocalSent(s, 'drive-summary:a', LA, AFTERNOON + MIN)).toBe(true);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 0 });
  });

  it('a cancel then a batched replacement counts one, not two', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON, { id: 'drive-summary:a', at: AFTERNOON + 2 * MIN });
    await uncountLocalSent(s, 'drive-summary:a', LA, AFTERNOON + MIN);
    const t = AFTERNOON + 30 * MIN;
    expect(await recordLocalSent(s, LA, t, { id: 'drive-summary:b', at: t + 2 * MIN })).toBe(1);
  });

  it('re-recording the same id replaces it rather than counting twice', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON, { id: 'drive-summary:a', at: AFTERNOON + 2 * MIN });
    expect(await recordLocalSent(s, LA, AFTERNOON, { id: 'drive-summary:a', at: AFTERNOON + 3 * MIN })).toBe(1);
  });

  it('a notification already delivered is never uncounted', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON, { id: 'drive-summary:a', at: AFTERNOON + 2 * MIN });
    expect(await uncountLocalSent(s, 'drive-summary:a', LA, AFTERNOON + 3 * MIN)).toBe(false);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 1 });
  });

  it('an unknown id uncounts nothing', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON);
    expect(await uncountLocalSent(s, 'nope', LA, AFTERNOON)).toBe(false);
    expect(s.peek(LOCAL_SENT_KEY)).toEqual({ day: '2026-09-22', count: 1 });
  });

  it('with buildCatalog(false) a summary is never counted', async () => {
    const s = memorySettings();
    const catalog = buildCatalog(false);
    expect(await recordLocalSent(s, LA, AFTERNOON, { type: 'trip_summary', catalog })).toBe(0);
    expect(await readLocalSent(s, LA, AFTERNOON)).toEqual({ day: '2026-09-22', count: 0 });
    expect(s.peek(LOCAL_LEDGER_KEY) ?? []).toEqual([]);
  });

  it('old days are pruned from the ledger', async () => {
    const s = memorySettings();
    await recordLocalSent(s, LA, AFTERNOON);
    await recordLocalSent(s, LA, AFTERNOON + 3 * 86_400_000);
    const ledger = s.peek(LOCAL_LEDGER_KEY) as unknown[];
    expect(ledger).toHaveLength(1);
  });

  it('an unreadable ledger falls back to the exported key for today (over-counting only holds back)', async () => {
    const s = memorySettings({
      [LOCAL_LEDGER_KEY]: 'garbage',
      [LOCAL_SENT_KEY]: { day: '2026-09-22', count: 2 },
    });
    expect(await readLocalSent(s, LA, AFTERNOON)).toEqual({ day: '2026-09-22', count: 2 });
    expect(await recordLocalSent(s, LA, AFTERNOON)).toBe(3);
  });

  it('a stale exported key from another day is not carried over', async () => {
    const s = memorySettings({ [LOCAL_SENT_KEY]: { day: '2026-09-20', count: 2 } });
    expect(await readLocalSent(s, LA, AFTERNOON)).toEqual({ day: '2026-09-22', count: 0 });
  });
});

describe('effective prefs', () => {
  const defaults = { quiet_enabled: true, quiet_start: '22:00', quiet_end: '07:00', tz: LA };

  it('no row: every category on, the config defaults for quiet hours', () => {
    expect(effectivePrefs(null, defaults)).toEqual(prefs());
  });

  it('a row: its explicit values win; nulls and missing categories fall back', () => {
    const row = {
      categories: { trip_summaries: false },
      quiet_enabled: null,
      quiet_start: '23:00:00',
      quiet_end: null,
    };
    expect(effectivePrefs(row, defaults)).toEqual({
      categories: { ...allOn(), trip_summaries: false },
      quiet: { enabled: true, start: '23:00', end: '07:00' },
    });
  });

  it('quiet hours switched off on the row', () => {
    const row = { categories: {}, quiet_enabled: false, quiet_start: null, quiet_end: null };
    expect(effectivePrefs(row, defaults).quiet).toEqual({ enabled: false, start: '22:00', end: '07:00' });
  });

  it('a malformed time falls back to the default', () => {
    const row = { categories: {}, quiet_enabled: null, quiet_start: '25:99', quiet_end: 'x' };
    expect(effectivePrefs(row, defaults).quiet).toEqual({ enabled: true, start: '22:00', end: '07:00' });
  });

  it('the cache round-trips, and an absent or broken cache reads as the defaults', async () => {
    const s = memorySettings();
    expect(await readCachedPrefs(s, defaults)).toEqual(prefs());
    const custom = prefs({ quiet: { enabled: false, start: '21:00', end: '06:00' } });
    await writePrefsCache(s, custom);
    expect(await readCachedPrefs(s, defaults)).toEqual(custom);
    await s.set(PREFS_CACHE_KEY, { nonsense: true });
    expect(await readCachedPrefs(s, defaults)).toEqual(prefs());
  });
});
