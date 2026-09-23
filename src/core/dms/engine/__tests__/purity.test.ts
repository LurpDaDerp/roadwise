/** @jest-environment node */
// The DMS engine is a pure function of its inputs (plan Task 5): every source under
// src/core/dms/engine imports only its own folder, and uses no clock, randomness, timer, console,
// dynamic require or React. Its time is the frame clock it is given. The one allowed outside import
// is the dms-vision constants file (PAUSE_AFTER_STOP_MS lives there once), which itself imports
// nothing.

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as {
  readdirSync: (d: string, o: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[];
  readFileSync: (f: string, e: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as {
  join: (...p: string[]) => string;
  resolve: (...p: string[]) => string;
  dirname: (p: string) => string;
  relative: (a: string, b: string) => string;
};

const ENGINE = path.resolve(__dirname, '..');
const CONSTANTS = path.resolve(__dirname, '..', '..', '..', '..', '..', 'modules', 'dms-vision', 'src', 'constants');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...sources(path.join(dir, e.name)));
    } else if (/\.tsx?$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Source with comments and string/template contents blanked, so neither can trip or satisfy a check. */
function stripped(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

function importsOf(src: string): string[] {
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!).concat(
    [...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
  );
}

const FILES = sources(ENGINE);
const BANNED: [string, RegExp][] = [
  ['Date', /\bDate\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['console', /\bconsole\b/],
  ['require(', /\brequire\s*\(/],
  ['react', /\breact\b/i],
  ['performance', /\bperformance\b/],
];

test('the engine folder has sources to check', () => {
  expect(FILES.length).toBeGreaterThanOrEqual(5);
});

test.each(FILES.map((f) => [path.relative(ENGINE, f), f]))('%s imports only the engine folder (and the dms-vision constants)', (_n, f) => {
  const src = fs.readFileSync(f, 'utf8');
  for (const spec of importsOf(src)) {
    const relative = spec.startsWith('./') || spec.startsWith('../');
    const target = relative ? path.resolve(path.dirname(f), spec) : spec;
    const inside = relative && !path.relative(ENGINE, target).startsWith('..');
    const allowed = inside || (relative && target === CONSTANTS);
    expect({ file: path.relative(ENGINE, f), spec, allowed }).toEqual({ file: path.relative(ENGINE, f), spec, allowed: true });
  }
});

test.each(FILES.map((f) => [path.relative(ENGINE, f), f]))('%s uses no clock, randomness, timer, console, require or React', (_n, f) => {
  const code = stripped(fs.readFileSync(f, 'utf8'));
  for (const [name, re] of BANNED) {
    expect({ file: path.relative(ENGINE, f), name, used: re.test(code) }).toEqual({ file: path.relative(ENGINE, f), name, used: false });
  }
});

test('the allowed constants file is itself pure: no imports at all', () => {
  const src = fs.readFileSync(`${CONSTANTS}.ts`, 'utf8');
  expect(importsOf(src)).toEqual([]);
});

test('the checks bite: a banned identifier and an outside import are both detected', () => {
  expect(BANNED.find(([n]) => n === 'Date')![1].test(stripped('const t = Date.now();'))).toBe(true);
  expect(BANNED.find(([n]) => n === 'Date')![1].test(stripped('// Date.now() in a comment\nconst s = "Date";'))).toBe(false);
  expect(importsOf("import { x } from '@/core/engine/machine';\nimport type { Y } from './types';")).toEqual(['@/core/engine/machine', './types']);
});
