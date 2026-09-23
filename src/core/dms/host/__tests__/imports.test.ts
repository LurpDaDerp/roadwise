/** @jest-environment node */
// One caller (plan rev1 S-M1; security T13 M-1): only src/core/dms/host/** (and the dev diagnostics route,
// when it exists) may import the native wrapper (whose start/setPolicy run the camera) or `createGate` (the
// token mint); `as GateToken` appears only in gate.ts. The wire, the types, the constants and the fake may
// be imported anywhere (they run nothing). This scans every source under src/ and app/.

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readdirSync: (d: string, o: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[]; readFileSync: (f: string, e: 'utf8') => string; existsSync: (p: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string; resolve: (...p: string[]) => string; relative: (a: string, b: string) => string };

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SELF = path.relative(ROOT, path.resolve(__dirname, 'imports.test.ts')).replace(/\\/g, '/');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app'))].map((f) => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }));

const HOST = (rel: string) => rel.startsWith('src/core/dms/host/') || rel.startsWith('app/(app)/dev/dms');
/** An import of the wrapper itself: the package root, its src/ folder or src/index. */
const WRAPPER = /from\s+'[^']*modules\/dms-vision(?:\/src)?(?:\/index)?'|from\s+'@\/?\.\.\/modules\/dms-vision'/;

test('the scan sees the host', () => {
  expect(files.some((f) => f.rel.startsWith('src/core/dms/host/'))).toBe(true);
});

test('only the host imports the native wrapper (start/setPolicy)', () => {
  const offenders = files.filter((f) => f.rel !== SELF && WRAPPER.test(f.src) && !HOST(f.rel)).map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test('only the host imports createGate (the token mint); the policy’s own tests aside', () => {
  const offenders = files
    .filter((f) => f.rel !== SELF && /\bcreateGate\b/.test(f.src) && /from\s+'[^']*policy\/gate'|from\s+'\.\/gate'|from\s+'\.\.\/gate'/.test(f.src))
    .filter((f) => !HOST(f.rel) && !f.rel.startsWith('src/core/dms/policy/'))
    .map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test('`as GateToken` appears only in gate.ts', () => {
  const offenders = files.filter((f) => f.rel !== SELF && /as\s+(unknown\s+as\s+)?GateToken\b/.test(f.src) && f.rel !== 'src/core/dms/policy/gate.ts').map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test('the scan bites', () => {
  expect(WRAPPER.test("import DmsVision from '../../../modules/dms-vision';")).toBe(true);
  expect(WRAPPER.test("import { FLAG } from '../../../modules/dms-vision/src/constants';")).toBe(false);
  expect(/as\s+(unknown\s+as\s+)?GateToken\b/.test('const t = s as GateToken;')).toBe(true);
});
