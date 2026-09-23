/** @jest-environment node */
// Battery (plan Global Constraints, design §3.5): nothing may run a timer, a sensor or the camera while the
// feature is armed but idle. The policy and the gate are pure functions of their inputs: no timer, no
// clock, no randomness (the gate's nonce is injected), no console, no native import. This scans them.

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readdirSync: (d: string) => string[]; readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string; resolve: (...p: string[]) => string };

const DIR = path.resolve(__dirname, '..');
const sources = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'));
const stripped = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

const BANNED: [string, RegExp][] = [
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['Date', /\bDate\b/],
  ['performance', /\bperformance\b/],
  ['Math.random', /Math\.random/],
  ['console', /\bconsole\b/],
];

test('the policy folder has sources', () => {
  expect(sources).toEqual(expect.arrayContaining(['capture.ts', 'gate.ts', 'constants.ts']));
});

test.each(sources)('%s: no timer, clock, randomness or console', (f) => {
  const code = stripped(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const [name, re] of BANNED) expect({ f, name, used: re.test(code) }).toEqual({ f, name, used: false });
});

test.each(sources)('%s: imports only the policy folder, the engine types and the dms-vision constants (never the native wrapper)', (f) => {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const froms = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
  for (const from of froms) {
    const ok = from.startsWith('./') || from === '../../../../modules/dms-vision/src/constants';
    expect({ f, from, ok }).toEqual({ f, from, ok: true });
  }
});

test('the scan bites', () => {
  expect(BANNED.find(([n]) => n === 'setInterval')![1].test(stripped('const h = setInterval(tick, 1000);'))).toBe(true);
  expect(BANNED.find(([n]) => n === 'setInterval')![1].test(stripped('// setInterval in a comment'))).toBe(false);
});
