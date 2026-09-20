import { CATEGORY, CONSTANTS, scoreTrip, severity } from '@scoring';
import type { EventCategory, ScorableEvent, ScoredTrip, TripMetrics } from '@scoring';

import {
  allTips,
  CATEGORY_PRIORITY,
  dayFallback,
  HIGH_SEVERITY,
  pickDailyTip,
  pickTopTip,
  TIP_STAGES,
  tips,
  type Tip,
  type TipStage,
} from '../tips';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The
// root tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the
// local shapes rather than an `import` from 'node:fs' (same pattern as `replay/__tests__`).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { readFileSync } = require('node:fs') as {
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const MPH = CONSTANTS.MPH;
const CATEGORIES = Object.keys(CATEGORY) as EventCategory[];

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w.length > 0);

// --- fixtures ------------------------------------------------------------------------------

const zeroDeductions = (): Record<EventCategory, number> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<EventCategory, number>;

/** A hand-built `ScoredTrip`: the exact deductions a case needs, without going through the engine. */
function scoredTrip(
  categoryDeductions: Partial<Record<EventCategory, number>>,
  eventDeductions: Record<string, number> = {}
): ScoredTrip {
  const deductions = { ...zeroDeductions(), ...categoryDeductions };
  const total = CATEGORIES.reduce((sum, c) => sum + deductions[c], 0);
  return {
    score: Math.max(0, Math.round(100 - total)),
    status: 'final',
    exposure: 1,
    dataQuality: 'A',
    categoryDeductions: deductions,
    eventDeductions,
    scoringVersion: 1,
  };
}

function event(
  id: string,
  category: EventCategory,
  measured: ScorableEvent['measured'],
  overrides: Partial<ScorableEvent> = {}
): ScorableEvent {
  return {
    id,
    category,
    startedAt: 1_700_000_000_000,
    durationS: 6,
    q: 0.9,
    corrected: false,
    status: 'scored',
    measured,
    context: { night: false, precipitation: false },
    ...overrides,
  };
}

/** One event per category, at a severity below that category's high band. */
const LOW_EVENTS: Record<EventCategory, ScorableEvent> = {
  phone: event('e-phone', 'phone', { speedMps: 6 * MPH }),
  speeding: event('e-speeding', 'speeding', { overMps: 6 * MPH, limitMps: 45 * MPH }),
  braking: event('e-braking', 'braking', { peakG: 0.32 }),
  accel: event('e-accel', 'accel', { peakG: 0.3 }),
  cornering: event('e-cornering', 'cornering', { lateralG: 0.37 }),
  focus: event('e-focus', 'focus', { glanceS: 2.5, focusKind: 'glance' }),
};

/** One event per category, at or above that category's high band. */
const HIGH_EVENTS: Record<EventCategory, ScorableEvent> = {
  phone: event('e-phone', 'phone', { speedMps: 35 * MPH }),
  speeding: event('e-speeding', 'speeding', { overMps: 16 * MPH, limitMps: 45 * MPH }),
  braking: event('e-braking', 'braking', { peakG: 0.5 }),
  accel: event('e-accel', 'accel', { peakG: 0.45 }),
  cornering: event('e-cornering', 'cornering', { lateralG: 0.5 }),
  focus: event('e-focus', 'focus', { glanceS: 4, focusKind: 'glance' }),
};

// --- catalogue invariants ------------------------------------------------------------------

describe('tip catalogue', () => {
  test('carries at least 24 category tips', () => {
    expect(tips.length).toBeGreaterThanOrEqual(24);
  });

  test('gives every scoring category at least four tips', () => {
    const counts = Object.fromEntries(
      CATEGORIES.map((c) => [c, tips.filter((t) => t.category === c).length])
    );
    const thin = Object.entries(counts).filter(([, count]) => count < 4);
    expect(thin).toEqual([]);
  });

  test('uses only scoring categories for the category tips', () => {
    for (const tip of tips) expect(CATEGORIES).toContain(tip.category);
  });

  test('keeps every id unique across the catalogue and the day fallback', () => {
    const ids = allTips.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('gives every tip a non-empty title, body, why, practice and source', () => {
    const empty = allTips.flatMap((tip) =>
      (['title', 'body', 'why', 'practice', 'source'] as const)
        .filter((field) => tip[field].trim().length === 0)
        .map((field) => `${tip.id}.${field}`)
    );
    expect(empty).toEqual([]);
  });

  test('writes every body as two or three sentences', () => {
    const wrong = allTips
      .map((tip) => ({ id: tip.id, count: sentences(tip.body).length }))
      .filter(({ count }) => count < 2 || count > 3);
    expect(wrong).toEqual([]);
  });

  test('keeps every sentence short enough to read at a glance', () => {
    const long = allTips.flatMap((tip) =>
      sentences(tip.body)
        .filter((sentence) => words(sentence).length > 28)
        .map((sentence) => `${tip.id}: ${sentence}`)
    );
    expect(long).toEqual([]);
  });

  test('writes why and practice as one sentence each', () => {
    for (const tip of allTips) {
      expect(sentences(tip.why)).toHaveLength(1);
      expect(sentences(tip.practice)).toHaveLength(1);
      expect(tip.practice.startsWith('This week')).toBe(true);
    }
  });

  test('keeps titles short enough for the tip card', () => {
    for (const tip of allTips) {
      expect(tip.title.length).toBeLessThanOrEqual(40);
      expect(words(tip.title).length).toBeLessThanOrEqual(8);
    }
  });

  test('lists at least one known stage on every tip', () => {
    for (const tip of allTips) {
      expect(tip.stages.length).toBeGreaterThanOrEqual(1);
      for (const stage of tip.stages) expect(TIP_STAGES).toContain(stage);
      expect(new Set(tip.stages).size).toBe(tip.stages.length);
    }
  });

  test('uses only severity bands the scoring package can produce', () => {
    for (const tip of tips) {
      const category = tip.category as EventCategory;
      expect([0, HIGH_SEVERITY[category]]).toContain(tip.minSeverity);
    }
  });

  // Exactly one candidate per slot is what makes `pickTopTip` unambiguous without leaning on the
  // catalogue order; the order is still the documented tie-break if a slot ever gains a second.
  test('covers every category, severity band and stage exactly once', () => {
    const slots = CATEGORIES.flatMap((category) =>
      TIP_STAGES.flatMap((stage) =>
        [0, HIGH_SEVERITY[category]].map((minSeverity) => ({
          slot: `${category}/${stage}/${minSeverity}`,
          matches: tips.filter(
            (t) =>
              t.category === category && t.stages.includes(stage) && t.minSeverity === minSeverity
          ).length,
        }))
      )
    );
    expect(slots.filter(({ matches }) => matches !== 1)).toEqual([]);
    expect(slots).toHaveLength(CATEGORIES.length * TIP_STAGES.length * 2);
  });

  test('cites recognised driver-education guidance on every tip', () => {
    const publishers = [
      'NHTSA',
      'IIHS',
      'UK Highway Code',
      'California DMV',
      "New York State Driver's Manual",
      'AAA Foundation',
      'National Safety Council',
    ];
    for (const tip of allTips) {
      expect(publishers.some((p) => tip.source.includes(p))).toBe(true);
    }
  });

  test('keeps a source comment beside every tip in the file', () => {
    const file = readFileSync(join(__dirname, '..', 'tips.ts'), 'utf8');
    const comments = file.match(/^\s*\/\/ Source: /gm) ?? [];
    expect(comments.length).toBe(allTips.length);
  });

  // §9.10: the score explains, the tip coaches. Describe the behaviour and the fix, never the
  // person — and never reach for fear, guilt, a legal threat, a medical claim or a statistic.
  test('uses no punishing, scare, legal, medical or statistical language', () => {
    const banned: RegExp[] = [
      /\bfail(s|ed|ing|ure)?\b/i,
      /\bpunish/i,
      /\bguilt/i,
      /\bshame|\bashamed\b/i,
      /\bstupid|\bcareless|\breckless|\bidiot/i,
      /\bbad\b/i,
      /\bdisappoint/i,
      /\bworried\b/i,
      /\byou (should|must|need to)\b/i,
      /\bcrash/i,
      /\bfatal|\bdeath\b|\bdie\b|\bkill|\bdeadly\b/i,
      /\billegal|\bticket|\bcitation|\bfines\b|\blawsuit|\bliabilit/i,
      /\binsurance\b/i,
      /\bdiagnos|\bmedication\b|\bcaffeine\b|\bcoffee\b|energy drink/i,
      /\d\s?%|\bpercent\b|\btimes more likely\b|\bstudies show\b|\bresearch shows\b|\bproven\b/i,
    ];
    const hits = allTips.flatMap((tip) => {
      const copy = [tip.title, tip.body, tip.why, tip.practice].join(' ');
      return banned.filter((p) => p.test(copy)).map((p) => `${tip.id}: ${String(p)}`);
    });
    expect(hits).toEqual([]);
  });
});

describe('day fallback', () => {
  test('holds at least four general tips', () => {
    expect(dayFallback.length).toBeGreaterThanOrEqual(4);
    for (const tip of dayFallback) expect(tip.category).toBe('general');
  });

  test('reads the same for both stages, so each lists both rather than appearing twice', () => {
    for (const tip of dayFallback) {
      expect([...tip.stages].sort()).toEqual([...TIP_STAGES].sort());
    }
  });

  test('applies at any severity', () => {
    for (const tip of dayFallback) expect(tip.minSeverity).toBe(0);
  });
});

// --- selection -------------------------------------------------------------------------------

describe('CATEGORY_PRIORITY', () => {
  test('lists every category once, largest cap first', () => {
    expect([...CATEGORY_PRIORITY].sort()).toEqual([...CATEGORIES].sort());
    expect(CATEGORY_PRIORITY).toEqual(['phone', 'speeding', 'focus', 'braking', 'cornering', 'accel']);
    for (let i = 1; i < CATEGORY_PRIORITY.length; i += 1) {
      const previous = CATEGORY_PRIORITY[i - 1] as EventCategory;
      const current = CATEGORY_PRIORITY[i] as EventCategory;
      expect(CATEGORY[previous].cap).toBeGreaterThanOrEqual(CATEGORY[current].cap);
    }
  });
});

describe('pickTopTip', () => {
  test('returns null for an unscored trip', () => {
    const trip: ScoredTrip = {
      score: null,
      status: 'unscored',
      reason: 'grade_c',
      exposure: 1,
      dataQuality: 'C',
      categoryDeductions: zeroDeductions(),
      eventDeductions: {},
      scoringVersion: 1,
    };
    expect(pickTopTip(trip, [])).toBeNull();
  });

  test('returns null for a discarded trip even if deductions are present', () => {
    const trip: ScoredTrip = {
      ...scoredTrip({ phone: 12 }, { 'e-phone': 12 }),
      score: null,
      status: 'discarded',
      reason: 'implausible_speed',
    };
    expect(pickTopTip(trip, [HIGH_EVENTS.phone])).toBeNull();
  });

  test('returns null when no category lost points', () => {
    expect(pickTopTip(scoredTrip({}), [])).toBeNull();
  });

  test('never coaches a category with a zero deduction', () => {
    for (const category of CATEGORIES) {
      const tip = pickTopTip(
        scoredTrip({ [category]: 5 }, { [`e-${category}`]: 5 }),
        Object.values(LOW_EVENTS)
      );
      expect(tip?.category).toBe(category);
    }
  });

  test('coaches the most costly category, not the one with the most events', () => {
    const trip = scoredTrip(
      { braking: 9, phone: 3 },
      { 'e-braking': 9, 'e-phone': 1.5, 'e-phone-2': 1.5 }
    );
    const events = [
      LOW_EVENTS.braking,
      LOW_EVENTS.phone,
      event('e-phone-2', 'phone', { speedMps: 6 * MPH }),
    ];
    expect(pickTopTip(trip, events)?.category).toBe('braking');
  });

  test('breaks a tie by category cap, biggest first', () => {
    const trip = scoredTrip({ phone: 6, speeding: 6, accel: 6 }, {});
    expect(pickTopTip(trip, [])?.category).toBe('phone');

    const withoutPhone = scoredTrip({ speeding: 6, accel: 6 }, {});
    expect(pickTopTip(withoutPhone, [])?.category).toBe('speeding');

    const focusVsBraking = scoredTrip({ focus: 4, braking: 4 }, {});
    expect(pickTopTip(focusVsBraking, [])?.category).toBe('focus');
  });

  test('returns the low-severity tip when the worst event is in a low band', () => {
    for (const category of CATEGORIES) {
      const scorable = LOW_EVENTS[category];
      expect(severity(scorable)).toBeGreaterThan(0);
      expect(severity(scorable)).toBeLessThan(HIGH_SEVERITY[category]);
      const tip = pickTopTip(scoredTrip({ [category]: 5 }, { [scorable.id]: 5 }), [scorable]);
      expect(tip?.minSeverity).toBe(0);
    }
  });

  test('returns the high-severity tip when the worst event reaches a top band', () => {
    for (const category of CATEGORIES) {
      const scorable = HIGH_EVENTS[category];
      expect(severity(scorable)).toBeGreaterThanOrEqual(HIGH_SEVERITY[category]);
      const tip = pickTopTip(scoredTrip({ [category]: 5 }, { [scorable.id]: 5 }), [scorable]);
      expect(tip?.minSeverity).toBe(HIGH_SEVERITY[category]);
    }
  });

  test('treats a drowsiness episode as a top-band focus event', () => {
    const drowsy = event('e-drowsy', 'focus', { focusKind: 'drowsiness' });
    const tip = pickTopTip(scoredTrip({ focus: 8 }, { 'e-drowsy': 8 }), [drowsy]);
    expect(tip?.minSeverity).toBe(HIGH_SEVERITY.focus);
  });

  test('takes the worst event in the category, not the first or the last', () => {
    const events = [LOW_EVENTS.braking, event('e-braking-2', 'braking', { peakG: 0.6 })];
    const trip = scoredTrip({ braking: 9 }, { 'e-braking': 3, 'e-braking-2': 6 });
    expect(pickTopTip(trip, events)?.minSeverity).toBe(HIGH_SEVERITY.braking);
    expect(pickTopTip(trip, [...events].reverse())?.minSeverity).toBe(HIGH_SEVERITY.braking);
  });

  test('ignores events that cost nothing, such as a possible or disputed one', () => {
    // The high-severity brake is present but absent from `eventDeductions`, so it never happened
    // as far as the score is concerned and must not drive the coaching either.
    const events = [LOW_EVENTS.braking, event('e-braking-2', 'braking', { peakG: 0.6 })];
    const trip = scoredTrip({ braking: 3 }, { 'e-braking': 3 });
    expect(pickTopTip(trip, events)?.minSeverity).toBe(0);
  });

  test('falls back to the low-severity tip when the caller supplies no events', () => {
    const tip = pickTopTip(scoredTrip({ cornering: 7 }, { 'e-cornering': 7 }), []);
    expect(tip?.category).toBe('cornering');
    expect(tip?.minSeverity).toBe(0);
  });

  test('respects the driver stage and defaults to new', () => {
    const trip = scoredTrip({ speeding: 11 }, { 'e-speeding': 11 });
    const events = [HIGH_EVENTS.speeding];
    expect(pickTopTip(trip, events, 'new')?.id).toBe('speeding-high-new');
    expect(pickTopTip(trip, events, 'experienced')?.id).toBe('speeding-high-experienced');
    expect(pickTopTip(trip, events)?.id).toBe('speeding-high-new');
  });

  test('returns a tip whose stages include the requested stage, for every category and band', () => {
    const stages: TipStage[] = [...TIP_STAGES];
    for (const category of CATEGORIES) {
      for (const bank of [LOW_EVENTS, HIGH_EVENTS]) {
        for (const stage of stages) {
          const scorable = bank[category];
          const tip = pickTopTip(
            scoredTrip({ [category]: 5 }, { [scorable.id]: 5 }),
            [scorable],
            stage
          );
          expect(tip).not.toBeNull();
          expect((tip as Tip).category).toBe(category);
          expect((tip as Tip).stages).toContain(stage);
        }
      }
    }
  });

  test('is deterministic: the same trip always produces the same tip', () => {
    const trip = scoredTrip(
      { phone: 14, speeding: 7, braking: 5 },
      { 'e-phone': 14, 'e-speeding': 7, 'e-braking': 5 }
    );
    const events = [HIGH_EVENTS.phone, LOW_EVENTS.speeding, LOW_EVENTS.braking];
    const first = pickTopTip(trip, events, 'experienced');
    for (let i = 0; i < 25; i += 1) {
      expect(pickTopTip(trip, events, 'experienced')).toBe(first);
      expect(pickTopTip(trip, [...events].reverse(), 'experienced')).toBe(first);
    }
    expect(first?.id).toBe('phone-high-experienced');
  });

  // Golden cases: the trip goes through the real scorer, so the tip follows the engine's own
  // deductions rather than a hand-written `ScoredTrip`.
  describe('scored by the engine', () => {
    const metrics: TripMetrics = {
      distanceM: 8 * CONSTANTS.MILE,
      durationS: 22 * 60,
      validGnssPct: 95,
      imuPresent: true,
      role: 'driver',
      maxSustainedSpeedMps: 31,
    };

    test('coaches phone use on the spec worked example', () => {
      const events: ScorableEvent[] = [
        event('phone-1', 'phone', { speedMps: 35 * MPH }, { durationS: 12, q: 0.9 }),
        event(
          'speeding-1',
          'speeding',
          { overMps: 12 * MPH, limitMps: 35 * MPH },
          { durationS: 45, q: 0.85, context: { night: false, precipitation: true } }
        ),
        event('braking-1', 'braking', { peakG: 0.42 }, { durationS: 1, q: 0.8 }),
      ];
      const scored = scoreTrip(metrics, events);
      expect(scored.status).toBe('final');
      expect(pickTopTip(scored, events)?.id).toBe('phone-high-new');
    });

    test('returns null for a clean drive', () => {
      const scored = scoreTrip(metrics, []);
      expect(scored.score).toBe(100);
      expect(pickTopTip(scored, [])).toBeNull();
    });

    test('returns null for a passenger trip', () => {
      const events = [HIGH_EVENTS.phone];
      const scored = scoreTrip({ ...metrics, role: 'passenger' }, events);
      expect(scored.status).toBe('unscored');
      expect(pickTopTip(scored, events)).toBeNull();
    });

    test('ignores a possible event that the engine did not charge for', () => {
      const possible = event('phone-possible', 'phone', { speedMps: 35 * MPH }, { status: 'possible' });
      const brake = event('brake-1', 'braking', { peakG: 0.33 }, { durationS: 1 });
      const events = [possible, brake];
      const scored = scoreTrip(metrics, events);
      expect(scored.categoryDeductions.phone).toBe(0);
      expect(pickTopTip(scored, events)?.category).toBe('braking');
    });
  });
});

describe('pickDailyTip', () => {
  test('is stable for the same seed', () => {
    for (const seed of ['user-1:2026-09-20', '', 'a', 'user-2:2026-09-21']) {
      const first = pickDailyTip(seed);
      expect(pickDailyTip(seed)).toBe(first);
      expect(pickDailyTip(seed)).toBe(first);
    }
  });

  test('always returns a general tip from the fallback list', () => {
    for (let day = 0; day < 60; day += 1) {
      const tip = pickDailyTip(`user-7:2026-01-${day}`);
      expect(dayFallback).toContain(tip);
      expect(tip.category).toBe('general');
    }
  });

  test('spreads seeds across the whole fallback list', () => {
    const seen = new Set<string>();
    for (let day = 0; day < 200; day += 1) seen.add(pickDailyTip(`user-7:day-${day}`).id);
    expect(seen.size).toBe(dayFallback.length);
  });

  test('gives different users different tips on the same day', () => {
    const ids = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((u) => pickDailyTip(`${u}:2026-09-20`).id)
    );
    expect(ids.size).toBeGreaterThan(1);
  });
});
