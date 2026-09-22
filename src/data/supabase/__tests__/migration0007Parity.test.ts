// Migration 0007's `public.is_short_drive` holds the scorer's minimum trip length in SQL, so the
// inbox writes no drive-summary row for a drive the phone never announced (ruling I9). This suite
// parses the thresholds out of the migration and holds them to the TypeScript scoring constants,
// so a change on either side fails here (ruling T2 (2); the pattern of the 0006 parity tests).
import { CONSTANTS } from '@scoring';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time; the root
// tsconfig's `types` is ["jest"], hence local shapes (the appConfig parity test's pattern).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { readFileSync } = require('node:fs') as {
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const migration0007 = (): string =>
  readFileSync(join(__dirname, '../../../../supabase/migrations/0007_inbox_push.sql'), 'utf8');

/** The body of `public.is_short_drive`, between its `as $$` and the closing `$$`. */
function isShortDriveBody(sql: string): string {
  const match = /create or replace function public\.is_short_drive\([^)]*\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/.exec(sql);
  if (match?.[1] === undefined) throw new Error('0007 has no public.is_short_drive');
  return match[1];
}

function threshold(body: string, param: string): number {
  const match = new RegExp(`coalesce\\(${param}, 0\\) < ([0-9.]+)`).exec(body);
  if (match?.[1] === undefined) throw new Error(`is_short_drive does not compare ${param}`);
  return Number(match[1]);
}

describe('0007 is_short_drive parity with the scorer', () => {
  const body = isShortDriveBody(migration0007());

  it('uses the scorer minimum distance', () => {
    expect(threshold(body, 'p_distance_m')).toBe(CONSTANTS.MIN_SCORED_DISTANCE_M);
  });

  it('uses the scorer minimum duration', () => {
    expect(threshold(body, 'p_duration_s')).toBe(CONSTANTS.MIN_SCORED_DURATION_S);
  });

  it('is short under either minimum, exactly as the scorer says too_short', () => {
    expect(body).toMatch(/coalesce\(p_distance_m, 0\) < [0-9.]+ or coalesce\(p_duration_s, 0\) < [0-9.]+/);
  });
});
