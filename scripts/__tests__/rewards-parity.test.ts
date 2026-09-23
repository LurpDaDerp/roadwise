// Migration 0009 holds the rewards rules in SQL (`public.reward_rules()`), and its settlement reads
// every constant from that JSON. packages/scoring's `rewardRulesJson()` is the app's copy. This suite
// parses the JSON literal out of the migration and deep-compares it, and holds the SQL's inbox.type
// list and the enqueue trigger's wall-clock hour to the same sources, so a change on either side fails
// here (M5 Task 2 Step 5; the pattern of 0006's and 0007's parity tests).
import { REWARDS, rewardRulesJson } from '@scoring';

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

// Task 4's six live types (Task 6 replaces this literal with [...LIVE_TYPES]).
const LIVE_TYPES_M5 = [
  'trip_summary',
  'permission_lapsed',
  'streak_milestone',
  'goal_completed',
  'level_up',
  'referral_qualified',
];

describe('0009 rewards parity', () => {
  const sql = migration();

  it('reward_rules() is exactly rewardRulesJson()', () => {
    expect(sqlRules(sql)).toEqual(rewardRulesJson());
  });

  it('the inbox.type CHECK lists exactly the six live types', () => {
    expect(inboxTypes(sql)).toEqual(LIVE_TYPES_M5);
  });

  it('the enqueue trigger uses the settle wall-clock hour', () => {
    const enqueue = /\(\(new\.day \+ 1\)::timestamp \+ interval '(\d+) hours'\) at time zone 'Etc\/GMT-14'/.exec(sql);
    expect(Number(enqueue?.[1])).toBe(REWARDS.SETTLE_WALL_CLOCK_H);
  });
});
