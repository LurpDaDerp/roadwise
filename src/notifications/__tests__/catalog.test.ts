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
      ttlHours: 24,
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

  test('streak milestones are M5, in the evening batch', () => {
    expect(CATALOG.streak_milestone).toMatchObject({
      producer: 'M5',
      live: false,
      window: { start: '18:00', end: '20:30' },
    });
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

  test('only the drive summary and the permission lapse are live', () => {
    expect(ALL.filter((e) => e.live).map((e) => e.type).sort()).toEqual([...LIVE_TYPES].sort());
    expect([...LIVE_TYPES]).toEqual(['trip_summary', 'permission_lapsed']);
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
    const valid: Partial<Record<NotificationType, unknown>> = { permission_lapsed: lapsePayload };
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

  test('a payload that fails its schema renders nothing', () => {
    expect(renderPush('permission_lapsed', { permission: 'camera' })).toBeNull();
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
  });
});
