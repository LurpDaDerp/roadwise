// Migration 0009 holds the rewards rules in SQL (`public.reward_rules()`), and its settlement reads
// every constant from that JSON. packages/scoring's `rewardRulesJson()` is the app's copy. This suite
// parses the JSON literal out of the migration and deep-compares it, and holds the SQL's inbox.type
// list and the enqueue trigger's wall-clock hour to the same sources, so a change on either side fails
// here (M5 Task 2 Step 5; the pattern of 0006's and 0007's parity tests). Migration 0011's referral
// code rule (the pattern and the normaliser) and its badge row are held to the same sources, over the
// normaliser test vectors that 0011's pgTAP file also runs (M5 Task 6 Step 5).
import { LIVE_TYPES } from '@/notifications/catalog';
import {
  BADGES,
  CHALLENGES,
  REFERRAL_CODE_PATTERN,
  REWARDS,
  normaliseReferralCode,
  rewardRulesJson,
} from '@scoring';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time; the root
// tsconfig's `types` is ["jest"], hence local shapes (the appConfig parity test's pattern).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { readFileSync } = require('node:fs') as {
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const migration = (): string =>
  readFileSync(join(__dirname, '../../supabase/migrations/0009_rewards_core.sql'), 'utf8');

const migration0010 = (): string =>
  readFileSync(join(__dirname, '../../supabase/migrations/0010_badges_challenges.sql'), 'utf8');

const migration0011 = (): string =>
  readFileSync(join(__dirname, '../../supabase/migrations/0011_referral.sql'), 'utf8');

/** The normaliser vectors 0011's pgTAP file runs: the JSON array between its `$vectors$` quotes. */
function referralVectors(): { input: string; expected: string }[] {
  const sql = readFileSync(join(__dirname, '../../supabase/tests/0011_referral.test.sql'), 'utf8');
  const block = /\$vectors\$(\[[\s\S]*?\])\$vectors\$/.exec(sql);
  if (block?.[1] === undefined) throw new Error('0011_referral.test.sql has no $vectors$ list');
  return JSON.parse(block[1]) as { input: string; expected: string }[];
}

/**
 * The code points `public.normalise_referral_code` strips besides the hyphen: its bracket class is
 * built from `chr(n)` terms, where a `'-'` term between two of them is a range.
 */
function sqlStrippedCodePoints(sql: string): Set<number> {
  const fn = /function public\.normalise_referral_code\(p_input text\)[\s\S]*?'\[' \|\|([\s\S]*?)\|\| '-\]'/.exec(sql);
  if (fn?.[1] === undefined) throw new Error('0011 has no normalise_referral_code class');
  const terms = [...fn[1].matchAll(/chr\((\d+)\)|'-'/g)].map((m) => (m[1] === undefined ? '-' : Number(m[1])));
  const out = new Set<number>();
  terms.forEach((term, i) => {
    if (term !== '-') {
      out.add(term);
      return;
    }
    const from = terms[i - 1];
    const to = terms[i + 1];
    if (typeof from !== 'number' || typeof to !== 'number') throw new Error('a range needs a chr() on each side');
    for (let cp = from; cp <= to; cp += 1) out.add(cp);
  });
  return out;
}

/** The value tuples of `insert into public.<table> (…) values (…), (…) on conflict`, as string fields. */
function seedRows(sql: string, table: string): string[][] {
  const insert = new RegExp(`insert into public\\.${table} \\([^)]*\\) values([\\s\\S]*?)on conflict`).exec(sql);
  if (insert?.[1] === undefined) throw new Error(`no seed insert for ${table}`);
  return [...insert[1].matchAll(/\(([^()]*)\)/g)].map((m) =>
    (m[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')),
  );
}

/** The JSON literal inside `public.reward_rules()` (between its `$json$` quotes). */
function sqlRules(sql: string): unknown {
  const fn = /create or replace function public\.reward_rules\(\)[\s\S]*?\$json\$([\s\S]*?)\$json\$/.exec(sql);
  if (fn?.[1] === undefined) throw new Error('0009 has no reward_rules() JSON literal');
  return JSON.parse(fn[1]) as unknown;
}

/** The type list of the inbox_type_check 0009 re-adds. */
function inboxTypes(sql: string): string[] {
  const check = /add constraint inbox_type_check\s+check \(type in \(([^)]*)\)\)/.exec(sql);
  if (check?.[1] === undefined) throw new Error('0009 does not re-add inbox_type_check');
  return check[1].split(',').map((t) => t.trim().replace(/^'|'$/g, ''));
}

describe('0009 rewards parity', () => {
  const sql = migration();

  it('reward_rules() is exactly rewardRulesJson()', () => {
    expect(sqlRules(sql)).toEqual(rewardRulesJson());
  });

  it('the inbox.type CHECK lists exactly the catalog LIVE_TYPES', () => {
    expect(inboxTypes(sql)).toEqual([...LIVE_TYPES]);
  });

  it('0010 seeds badge_defs with BADGES exactly (all but referrals_1, which 0011 seeds with its producer)', () => {
    const rows = seedRows(migration0010(), 'badge_defs').map(([id, family, tier, metric, threshold, sort]) => ({
      id,
      family,
      tier,
      metric,
      threshold: Number(threshold),
      sort: Number(sort),
    }));
    expect(rows).toHaveLength(15);
    expect(rows).toEqual(BADGES.filter((b) => b.id !== 'referrals_1').map((b) => ({ ...b })));
  });

  it('0010 seeds challenge_defs with CHALLENGES exactly', () => {
    const rows = seedRows(migration0010(), 'challenge_defs').map(([id, predicate, targetDays, windowDays, points, sort]) => ({
      id,
      predicate,
      targetDays: Number(targetDays),
      windowDays: Number(windowDays),
      points: Number(points),
      sort: Number(sort),
    }));
    expect(rows).toEqual(CHALLENGES.map((c) => ({ ...c })));
  });

  it('the enqueue trigger takes the settle wall-clock hour from the rules (through reward_wall_close), hard-coding none', () => {
    // final review I1/m6: the enqueue queues at the day's real close, which reward_wall_close computes
    // from reward_rules().SETTLE_WALL_CLOCK_H (held to REWARDS by the first test above)
    const enqueue = /create or replace function public\.enqueue_reward_settlement\(\)[\s\S]*?end \$\$;/.exec(sql)?.[0] ?? '';
    expect(enqueue).toContain('public.reward_wall_close(new.day,');
    expect(enqueue).not.toMatch(/interval '\d+ hours'/);
    const wallClose = /create or replace function public\.reward_wall_close\([\s\S]*?end \$\$;/.exec(sql)?.[0] ?? '';
    expect(wallClose).toContain("(public.reward_rules() ->> 'SETTLE_WALL_CLOCK_H')::int");
    expect(REWARDS.SETTLE_WALL_CLOCK_H).toBe(2);
  });
});

describe('0011 referral parity', () => {
  const sql = migration0011();

  it('every code pattern in 0011 is REFERRAL_CODE_PATTERN, over CODE_ALPHABET', () => {
    const patterns = [...sql.matchAll(/'(\^\[[A-Z0-9]+\]\{\d+\}\$)'/g)].map((m) => m[1]);
    expect(patterns).toHaveLength(2);
    for (const p of patterns) expect(p).toBe(REFERRAL_CODE_PATTERN.source);
    expect(REFERRAL_CODE_PATTERN.source).toBe(
      `^[${REWARDS.REFERRAL.CODE_ALPHABET}]{${REWARDS.REFERRAL.CODE_LENGTH}}$`,
    );
  });

  it('the SQL normaliser strips exactly the code points a JS whitespace class matches (the hyphen aside)', () => {
    const stripped = sqlStrippedCodePoints(sql);
    const mismatches: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (/\s/.test(String.fromCharCode(cp)) !== stripped.has(cp)) mismatches.push(cp);
    }
    expect(mismatches).toEqual([]);
  });

  it('normaliseReferralCode gives the expected output on every vector the 0011 pgTAP file runs', () => {
    const vectors = referralVectors();
    expect(vectors.length).toBeGreaterThanOrEqual(19);
    for (const v of vectors) expect(normaliseReferralCode(v.input)).toBe(v.expected);
  });

  it('0011 seeds referrals_1 exactly as BADGES has it', () => {
    const rows = seedRows(sql, 'badge_defs').map(([id, family, tier, metric, threshold, sort]) => ({
      id,
      family,
      tier,
      metric,
      threshold: Number(threshold),
      sort: Number(sort),
    }));
    expect(rows).toEqual(BADGES.filter((b) => b.id === 'referrals_1').map((b) => ({ ...b })));
  });
});
