/**
 * The guard that points are gone for good: no copy the app prints or speaks names points, streaks,
 * freezes, levels, a leaderboard or the global board, and a drive's merit tier has no name anywhere
 * (it shows only as its icon and colour).
 *
 * It reads every copy module (each `copy.ts` under src/features, the content under src/content, the
 * driving screen's `hudCopy` and the English strings), walks every exported value, and calls every
 * exported function with sample arguments so templated lines are read too.
 */
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings
const fs = require('node:fs') as {
  readdirSync: (dir: string, opts: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...parts: string[]) => string; relative: (from: string, to: string) => string };

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const ROOT = path.join(__dirname, '..', '..');

/** The words of the points era. */
const POINTS = /\bpoints?\b|\bpts\b|streaks?|freezes?|\blevel \d|leaderboard|global board|phone pickup/i;
/**
 * The names a merit tier must never have. "Steady" is also the Safety Rating's word for a week
 * without change ("Steady this week"), so it is allowed under a trend's own `steady` key only.
 */
const TIER_NAMES = /\b(Rolling|Steady|Smooth drive|Polished|Grand tour)\b/;
const TREND_WORD = /\.steady$/;

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === '__fixtures__' || e.name === '__e2e__') continue;
      out.push(...walk(full, keep));
    } else if (keep(e.name)) out.push(full);
  }
  return out;
}

const COPY_FILES = [
  ...walk(path.join(ROOT, 'src', 'features'), (n) => n === 'copy.ts'),
  ...walk(path.join(ROOT, 'src', 'content'), (n) => n.endsWith('.ts')),
  path.join(ROOT, 'src', 'features', 'drive', 'hudCopy.ts'),
  path.join(ROOT, 'src', 'i18n', 'en.ts'),
];

/** Sample arguments a copy function is called with: numbers, a name, a count. */
const SAMPLES: unknown[][] = [[], [2], [1], [0], ['maya'], [2, 3], ['maya', 2], [{ n: 2 }]];

/** Every string in a value, with its key path; functions are called with the samples. */
function strings(value: unknown, at: string, seen = new Set<unknown>()): { at: string; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (typeof value === 'function') {
    const out: { at: string; text: string }[] = [];
    for (const args of SAMPLES) {
      try {
        out.push(...strings((value as (...a: unknown[]) => unknown)(...args), `${at}()`, seen));
      } catch {
        // Not callable with these arguments.
      }
    }
    return out;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`, seen));
}

/** Every key path in a value. */
function keys(value: unknown, at: string, seen = new Set<unknown>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([k, v]) => [`${at}.${k}`, ...keys(v, `${at}.${k}`, seen)]);
}

const modules = COPY_FILES.map((file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- each copy module, read whole
  return { rel, exports: require(file) as Record<string, unknown> };
});

test('the guard reads the copy it is meant to', () => {
  const rels = modules.map((m) => m.rel);
  for (const must of ['src/features/home/copy.ts', 'src/features/drives/copy.ts', 'src/content/howScores.ts', 'src/features/drive/hudCopy.ts', 'src/i18n/en.ts']) {
    expect(rels).toContain(must);
  }
  expect(modules.flatMap((m) => strings(m.exports, m.rel)).length).toBeGreaterThan(500);
});

test.each(modules.map((m) => [m.rel, m] as const))('%s names no points, streaks, freezes, levels or leaderboards', (_rel, m) => {
  const hits = strings(m.exports, m.rel).filter((s) => POINTS.test(s.text));
  expect(hits).toEqual([]);
});

test.each(modules.map((m) => [m.rel, m] as const))('%s gives a merit tier no name', (_rel, m) => {
  expect(strings(m.exports, m.rel).filter((s) => TIER_NAMES.test(s.text) && !TREND_WORD.test(s.at))).toEqual([]);
  expect(keys(m.exports, m.rel).filter((k) => /merit.*name/i.test(k))).toEqual([]);
});
