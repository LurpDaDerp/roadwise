import {
  CAP_EXEMPT_CLASSES,
  CATALOG,
  NOTIFICATION_CATEGORIES,
  buildCatalog,
  DAILY_CAP,
  DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP,
  LIVE_TYPES,
  PayloadSchemas,
  countsTowardDailyCap,
  renderInboxBase,
  renderPush,
  type NotificationType,
} from '../catalog';
import {
  INBOX_QUERY_KEY,
  LOCAL_SENT_KEY,
  REWARDS_QUERY_KEY,
  OPENED_TRIPS_KEY,
  PREFS_CACHE_KEY,
  PREFS_QUERY_KEY,
} from '../keys';

/** Every P0 row of product spec §11.2, by its catalog name. */
const P0_TYPES: NotificationType[] = [
  'trip_summary',
  'permission_lapsed',
  'missed_drive',
  'streak_milestone',
  'goal_completed',
  'level_up',
  'referral_qualified',
  'family_membership',
  'family_sharing_changed',
  'family_digest',
  'data_export_ready',
  'transparency_reminder',
];

const ALL = Object.values(CATALOG);

const tripPayload = {
  clientTripId: 'trip_01-A',
  startedAt: '2026-09-22T08:00:00.000Z',
  endedAt: '2026-09-22T08:20:00.000Z',
  distanceM: 8047,
  status: 'provisional' as const,
  roleUnknown: false,
};
const lapsePayload = { permission: 'location' as const, platform: 'ios' as const, deviceId: 'dev-1' };
const streakPayload = { days: 14, reachedOn: '2026-09-21' };
const weeklyPayload = { kind: 'weekly_goal', category: 'phone', weekStart: '2026-09-14', points: 150, prorated: false };
const challengePayload = { kind: 'challenge', challengeId: 'phone_down', points: 200 };
const levelPayload = { kind: 'level', level: 2, name: 'Steady' };
const badgePayload = { kind: 'badge', badgeId: 'safe_days_7', tier: 'bronze' };
const referralPayload = { role: 'invitee', points: 500 };

describe('the catalog', () => {
  test('holds every §11.2 P0 row and nothing else', () => {
    expect(Object.keys(CATALOG).sort()).toEqual([...P0_TYPES].sort());
  });

  test('the runtime category list is every H6 category, and every entry uses one', () => {
    expect([...NOTIFICATION_CATEGORIES]).toEqual([
      'trip_summaries',
      'recording',
      'rewards',
      'family',
      'safety',
      'product',
      'weekly_recap',
      'crews',
    ]);
    for (const e of ALL) expect(NOTIFICATION_CATEGORIES).toContain(e.category);
  });

  test('each entry names itself', () => {
    for (const [key, entry] of Object.entries(CATALOG)) expect(entry.type).toBe(key);
  });

  test('the drive summary is local, produced by M3, on the trips channel', () => {
    expect(CATALOG.trip_summary).toMatchObject({
      category: 'trip_summaries',
      capClass: 'standard',
      priority: 'normal',
      androidChannel: 'trips',
      delivery: 'local',
      producer: 'M3',
      live: true,
      ttlHours: 12,
    });
  });

  test('a permission lapse is pushed by M4 on the recording-problems channel', () => {
    expect(CATALOG.permission_lapsed).toMatchObject({
      category: 'recording',
      capClass: 'standard',
      priority: 'normal',
      androidChannel: 'recording_problems',
      delivery: 'push',
      producer: 'M4',
      live: true,
      ttlHours: 48,
    });
  });

  test('the missed-drive explanation is reserved: next morning, at most once a week, low', () => {
    expect(CATALOG.missed_drive).toMatchObject({
      live: false,
      producer: 'unassigned',
      window: { start: '08:00', end: '11:00' },
      weeklyLimit: 1,
      priority: 'low',
    });
  });

  test('streak milestones are M5, live, in the evening batch', () => {
    expect(CATALOG.streak_milestone).toMatchObject({
      producer: 'M5',
      live: true,
      window: { start: '18:00', end: '20:30' },
    });
  });

  test('the four rewards types are live M5 pushes in the rewards category, capped as standard', () => {
    for (const t of ['streak_milestone', 'goal_completed', 'level_up', 'referral_qualified'] as const) {
      expect(CATALOG[t]).toMatchObject({
        live: true,
        delivery: 'push',
        producer: 'M5',
        category: 'rewards',
        capClass: 'standard',
        androidChannel: 'rewards',
      });
      expect(countsTowardDailyCap(t)).toBe(true);
    }
  });

  test('goal, class/badge and referral arrive only 09:00-20:30, so a 02:05 settlement never buzzes', () => {
    for (const t of ['goal_completed', 'level_up', 'referral_qualified'] as const) {
      expect(CATALOG[t].window).toEqual({ start: '09:00', end: '20:30' });
    }
  });

  test('rewards TTLs are unchanged: 24 h for a streak, 48 h for the rest (covers 02:05 to 09:00)', () => {
    expect(CATALOG.streak_milestone.ttlHours).toBe(24);
    for (const t of ['goal_completed', 'level_up', 'referral_qualified'] as const) {
      expect(CATALOG[t].ttlHours).toBe(48);
    }
  });

  test('rewards rows are M5, family rows M6 in the family cap class, export M8, transparency M6 promo', () => {
    for (const t of ['goal_completed', 'level_up', 'referral_qualified'] as const) {
      expect(CATALOG[t].producer).toBe('M5');
    }
    for (const t of ['family_membership', 'family_sharing_changed', 'family_digest'] as const) {
      expect(CATALOG[t]).toMatchObject({ producer: 'M6', capClass: 'family', category: 'family' });
    }
    expect(CATALOG.transparency_reminder).toMatchObject({ producer: 'M6', capClass: 'promo' });
    expect(CATALOG.data_export_ready.producer).toBe('M8');
  });

  test('the live types are the drive summary, the lapse and the four rewards types, in this order', () => {
    expect(ALL.filter((e) => e.live).map((e) => e.type).sort()).toEqual([...LIVE_TYPES].sort());
    expect([...LIVE_TYPES]).toEqual([
      'trip_summary',
      'permission_lapsed',
      'streak_milestone',
      'goal_completed',
      'level_up',
      'referral_qualified',
    ]);
  });

  test('every window is HH:MM–HH:MM and every ttl is positive', () => {
    for (const e of ALL) {
      expect(e.ttlHours).toBeGreaterThan(0);
      if (e.window) {
        expect(e.window.start).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        expect(e.window.end).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      }
    }
  });

  test('no pushed type is marked local by accident, and no local type is pushed', () => {
    expect(ALL.filter((e) => e.delivery === 'local').map((e) => e.type)).toEqual(['trip_summary']);
  });
});

describe('the daily cap (§11.1 rule 2)', () => {
  test('two non-family a day, one promotional a week', () => {
    expect(DAILY_CAP).toEqual({ nonFamilyPerDay: 2, promoPer7Days: 1 });
  });

  test('the pending reading: drive summaries count, and CATALOG is built from the switch', () => {
    expect(DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP).toBe(true);
    expect(CATALOG).toEqual(buildCatalog(DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP));
  });

  test('switch on: the drive summary is standard, so every capClass reader counts it', () => {
    const cat = buildCatalog(true);
    expect(cat.trip_summary.capClass).toBe('standard');
    expect(countsTowardDailyCap('trip_summary', cat)).toBe(true);
  });

  test('switch off: the drive summary is transactional, so every capClass reader exempts it', () => {
    const cat = buildCatalog(false);
    expect(cat.trip_summary.capClass).toBe('transactional');
    expect(CAP_EXEMPT_CLASSES).toContain('transactional');
    expect(countsTowardDailyCap('trip_summary', cat)).toBe(false);
  });

  test('the switch changes the drive summary and nothing else', () => {
    const on = buildCatalog(true);
    const off = buildCatalog(false);
    for (const t of P0_TYPES) {
      if (t === 'trip_summary') {
        expect({ ...off[t], capClass: 'standard' }).toEqual(on[t]);
      } else {
        expect(off[t]).toEqual(on[t]);
        expect(countsTowardDailyCap(t, off)).toBe(countsTowardDailyCap(t, on));
      }
    }
  });

  test('countsTowardDailyCap is exactly "capClass is not exempt"', () => {
    for (const e of ALL) {
      expect(countsTowardDailyCap(e.type)).toBe(!CAP_EXEMPT_CLASSES.includes(e.capClass));
    }
  });

  test('family rows are exempt; standard and promo rows count', () => {
    expect(countsTowardDailyCap('family_digest')).toBe(false);
    expect(countsTowardDailyCap('family_membership')).toBe(false);
    expect(countsTowardDailyCap('permission_lapsed')).toBe(true);
    expect(countsTowardDailyCap('transparency_reminder')).toBe(true);
  });
});

describe('payload schemas', () => {
  test('trip_summary accepts the contract and refuses drift', () => {
    expect(PayloadSchemas.trip_summary.safeParse(tripPayload).success).toBe(true);
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, extra: 1 }).success).toBe(false);
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, clientTripId: 'a/b' }).success).toBe(false);
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, clientTripId: 'x'.repeat(65) }).success).toBe(
      false
    );
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, distanceM: -1 }).success).toBe(false);
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, status: 'scored' }).success).toBe(false);
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, scorableIfDriver: true }).success).toBe(true);
    expect(PayloadSchemas.trip_summary.safeParse({ ...tripPayload, scorableIfDriver: 'yes' }).success).toBe(false);
  });

  test('permission_lapsed accepts the contract and refuses drift', () => {
    expect(PayloadSchemas.permission_lapsed.safeParse(lapsePayload).success).toBe(true);
    expect(PayloadSchemas.permission_lapsed.safeParse({ ...lapsePayload, permission: 'camera' }).success).toBe(false);
    expect(PayloadSchemas.permission_lapsed.safeParse({ ...lapsePayload, platform: 'web' }).success).toBe(false);
    expect(PayloadSchemas.permission_lapsed.safeParse({ ...lapsePayload, deviceId: 'd'.repeat(129) }).success).toBe(
      false
    );
    expect(PayloadSchemas.permission_lapsed.safeParse({ ...lapsePayload, extra: true }).success).toBe(false);
  });

  test('streak_milestone accepts the contract and refuses drift', () => {
    const ok = (p: unknown) => PayloadSchemas.streak_milestone.safeParse(p).success;
    expect(ok(streakPayload)).toBe(true);
    expect(ok({ ...streakPayload, days: 0 })).toBe(false);
    expect(ok({ ...streakPayload, days: 10001 })).toBe(false);
    expect(ok({ ...streakPayload, days: 7.5 })).toBe(false);
    expect(ok({ ...streakPayload, reachedOn: '2026-9-21' })).toBe(false);
    expect(ok({ ...streakPayload, place: 'x' })).toBe(false);
  });

  test('goal_completed: a weekly goal or a challenge, nothing else', () => {
    const ok = (p: unknown) => PayloadSchemas.goal_completed.safeParse(p).success;
    expect(ok(weeklyPayload)).toBe(true);
    expect(ok({ ...weeklyPayload, prorated: true })).toBe(true);
    expect(ok(challengePayload)).toBe(true);
    expect(ok({ ...weeklyPayload, category: 'focus' })).toBe(false);
    expect(ok({ ...weeklyPayload, weekStart: 'Monday' })).toBe(false);
    expect(ok({ ...weeklyPayload, points: 0 })).toBe(false);
    expect(ok({ ...weeklyPayload, points: 1001 })).toBe(false);
    expect(ok({ ...weeklyPayload, points: 1.5 })).toBe(false);
    expect(ok({ ...weeklyPayload, prorated: 'no' })).toBe(false);
    expect(ok({ ...weeklyPayload, extra: 1 })).toBe(false);
    expect(ok({ ...challengePayload, challengeId: 'drive_100_miles' })).toBe(false);
    expect(ok({ ...challengePayload, extra: 1 })).toBe(false);
    expect(ok({ ...challengePayload, kind: 'weekly_goal' })).toBe(false);
    expect(ok({ kind: 'crew', points: 10 })).toBe(false);
  });

  test('level_up: a class (2-6, with its own name) or a badge (a known id and tier)', () => {
    const ok = (p: unknown) => PayloadSchemas.level_up.safeParse(p).success;
    expect(ok(levelPayload)).toBe(true);
    expect(ok({ kind: 'level', level: 6, name: 'Mentor' })).toBe(true);
    expect(ok({ kind: 'level', level: 1, name: 'Learner' })).toBe(false);
    expect(ok({ kind: 'level', level: 7, name: 'Mentor' })).toBe(false);
    expect(ok({ kind: 'level', level: 2, name: 'Mentor' })).toBe(false);
    expect(ok({ ...levelPayload, extra: 1 })).toBe(false);
    expect(ok(badgePayload)).toBe(true);
    expect(ok({ ...badgePayload, badgeId: 'night_owl' })).toBe(false);
    expect(ok({ ...badgePayload, tier: 'platinum' })).toBe(false);
    expect(ok({ ...badgePayload, extra: 1 })).toBe(false);
  });

  test('referral_qualified: a role and the points, nothing about the other person', () => {
    const ok = (p: unknown) => PayloadSchemas.referral_qualified.safeParse(p).success;
    expect(ok(referralPayload)).toBe(true);
    expect(ok({ role: 'referrer', points: 500 })).toBe(true);
    expect(ok({ role: 'friend', points: 500 })).toBe(false);
    expect(ok({ role: 'referrer', points: 0 })).toBe(false);
    expect(ok({ ...referralPayload, inviteeName: 'Sam' })).toBe(false);
  });

  test('a schema exists for exactly the live types', () => {
    expect(Object.keys(PayloadSchemas).sort()).toEqual([...LIVE_TYPES].sort());
  });
});

describe('push copy', () => {
  test('a local type is never pushed', () => {
    expect(renderPush('trip_summary', tripPayload)).toBeNull();
    for (const e of ALL.filter((x) => x.delivery === 'local')) expect(renderPush(e.type, tripPayload)).toBeNull();
  });

  test('every live push type renders from a valid payload', () => {
    const valid: Partial<Record<NotificationType, unknown>> = {
      permission_lapsed: lapsePayload,
      streak_milestone: streakPayload,
      goal_completed: weeklyPayload,
      level_up: levelPayload,
      referral_qualified: referralPayload,
    };
    for (const e of ALL.filter((x) => x.live && x.delivery === 'push')) {
      expect(renderPush(e.type, valid[e.type])).not.toBeNull();
    }
  });

  test('the delivery guard holds on its own: a live type marked local is not pushed', () => {
    const cat = buildCatalog(true);
    const localLapse = { ...cat, permission_lapsed: { ...cat.permission_lapsed, delivery: 'local' as const } };
    expect(renderPush('permission_lapsed', lapsePayload, cat)).not.toBeNull();
    expect(renderPush('permission_lapsed', lapsePayload, localLapse)).toBeNull();
  });

  test('a payload that fails its schema renders nothing (an unknown badge from a newer server included)', () => {
    expect(renderPush('permission_lapsed', { permission: 'camera' })).toBeNull();
    expect(renderPush('level_up', { kind: 'badge', badgeId: 'from_a_newer_server', tier: 'gold' })).toBeNull();
    expect(renderPush('goal_completed', { kind: 'challenge', challengeId: 'unknown', points: 200 })).toBeNull();
    expect(renderPush('streak_milestone', {})).toBeNull();
    expect(renderPush('referral_qualified', null)).toBeNull();
  });

  test('non-live entries carry no copy', () => {
    for (const e of ALL.filter((x) => !x.live)) {
      expect(renderPush(e.type, {})).toBeNull();
      expect(renderInboxBase(e.type, {})).toBeNull();
    }
  });
});

describe('storage and query keys', () => {
  test('are the names the other lanes read', () => {
    expect(OPENED_TRIPS_KEY).toBe('notifications.openedTrips');
    expect(LOCAL_SENT_KEY).toBe('notifications.localSent');
    expect(PREFS_CACHE_KEY).toBe('notifications.prefs');
    expect(INBOX_QUERY_KEY).toEqual(['inbox']);
    expect(PREFS_QUERY_KEY).toEqual(['notificationPrefs']);
    expect(REWARDS_QUERY_KEY).toEqual(['rewards']);
  });
});
