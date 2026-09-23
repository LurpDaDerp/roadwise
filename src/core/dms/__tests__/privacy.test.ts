/** @jest-environment node */
// The privacy sweep (plan Task 15; plan "Privacy"): no frame, landmark, GateToken or profile leaves the device
// or reaches a log. The native side has its own sweeps (modules/dms-vision/__tests__/native-*.test.ts: no
// pixels out, no storage, no network, logging only through DmsLog's static codes). This one covers the
// JavaScript side:
// 1. The DMS code (src/core/dms, modules/dms-vision/src, the dev panel and its route) calls no console, no
//    network, no storage and no telemetry. Code only: comments may name what is forbidden. (The panel reads
//    the signed-in profile's age band through the session hook, `@/data/supabase/session`: a read of what
//    the app already holds, not a call; the Supabase client itself is forbidden.)
// 2. Nothing else in the repo imports the DMS lane yet, except the dev panel; M7 will add itself here under
//    review (its uploads need a disclosure and consent first: README, "Where the data may go").
// 3. The profile's settings key is written only by the profile store.
// 4. The upload contract (the client's and the server's payload schemas) and the backend carry no DMS field.

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readdirSync: (d: string, o: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[]; readFileSync: (f: string, e: 'utf8') => string; existsSync: (p: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string; resolve: (...p: string[]) => string; relative: (a: string, b: string) => string };

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TEST = /(^|\/)__tests__\/|(^|\/)__fixtures__\/|\.test\.tsx?$/;

function walk(dir: string, ext: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}
const load = (dirs: string[], ext = /\.(ts|tsx)$/) =>
  dirs
    .flatMap((d) => walk(path.join(ROOT, d), ext))
    .map((f) => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }))
    .filter((f) => !TEST.test(f.rel));

/** Source without comments, so a comment can neither trip nor satisfy a rule. */
export function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const DMS_FILES = [...load(['src/core/dms', 'modules/dms-vision/src']), ...['src/features/dev/DmsDiagnosticsPanel.tsx', 'app/(app)/dev/dms.tsx'].map((rel) => ({ rel, src: fs.readFileSync(path.join(ROOT, rel), 'utf8') }))];

/** What DMS code must never call or import. */
export const FORBIDDEN: [string, RegExp][] = [
  ['console', /\bconsole\s*\.\s*\w+\s*\(/],
  ['network', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\baxios\b|\bsendBeacon\b|['"]@supabase\/|['"]@\/data\/supabase\/(?!session['"])|['"]@\/data\/sync/],
  ['storage', /\bAsyncStorage\b|\bSecureStore\b|['"]expo-secure-store['"]|['"]expo-file-system|\bFileSystem\b|\blocalStorage\b|\bsessionStorage\b|\bMMKV\b|['"]expo-sqlite['"]|['"]@\/data\/db/],
  ['telemetry', /\bSentry\b|['"]@sentry\/|\bcaptureException\b|\banalytics\b|\btrackEvent\b/],
];

/** The rules a source breaks. */
export function breaks(src: string): string[] {
  const c = code(src);
  return FORBIDDEN.filter(([, re]) => re.test(c)).map(([name]) => name);
}

describe('1. DMS code: no console, network, storage or telemetry', () => {
  test('the sweep sees the host, the engine, the wrapper and the panel', () => {
    const rels = DMS_FILES.map((f) => f.rel);
    for (const want of ['src/core/dms/host/controller.ts', 'src/core/dms/engine/engine.ts', 'modules/dms-vision/src/index.ts', 'src/features/dev/DmsDiagnosticsPanel.tsx']) expect(rels).toContain(want);
  });
  test('no file breaks a rule', () => {
    expect(DMS_FILES.map((f) => ({ f: f.rel, broken: breaks(f.src) })).filter((x) => x.broken.length > 0)).toEqual([]);
  });
  test.each([
    ['console', `console.log('frame', f);`],
    ['network', `await fetch(url, { body });`],
    ['network', `import { supabase } from '@/data/supabase/client';`],
    ['storage', `await AsyncStorage.setItem('k', v);`],
    ['storage', `import { createSettingsRepo } from '@/data/db';`],
    ['telemetry', `Sentry.captureException(e);`],
  ])('the sweep bites (%s): %s', (rule, line) => {
    expect(breaks(line)).toContain(rule);
  });
  test('comments are not code', () => {
    expect(breaks('// never console.log a frame\n/* no fetch( here */\nconst x = 1;')).toEqual([]);
  });
});

describe('2. who imports the DMS lane', () => {
  const REPO = load(['src', 'app', 'packages', 'scripts', 'supabase/functions'], /\.(ts|tsx|js)$/);
  const ALLOWED = new Set(['src/features/dev/DmsDiagnosticsPanel.tsx']);
  test('outside src/core/dms, only the dev panel (M7 adds itself under review)', () => {
    const importers = REPO.filter((f) => !f.rel.startsWith('src/core/dms/') && /['"](?:@\/core\/dms|[./]*\/core\/dms)(?:\/[^'"]*)?['"]/.test(code(f.src))).map((f) => f.rel);
    expect(importers.filter((r) => !ALLOWED.has(r))).toEqual([]);
  });
  test('the profile key is written only by the profile store', () => {
    const users = REPO.filter((f) => /['"]dms\.profile['"]/.test(code(f.src))).map((f) => f.rel);
    expect(users).toEqual(['src/core/dms/host/profileStore.ts']);
  });
});

describe('3. the upload contract and the backend carry nothing of the DMS', () => {
  const DMS_WORDS = /\b(dms|gaze|gazeRel|landmarks?|iris|perclos|gatetoken|dmsprofile)\b/i;
  test('the payload schemas (client and server) and the trip finaliser', () => {
    for (const rel of ['src/data/sync/payload.ts', 'supabase/functions/_shared/payload.ts', 'src/core/engine/finalize.ts']) {
      expect({ rel, dms: DMS_WORDS.test(code(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) }).toEqual({ rel, dms: false });
    }
  });
  test('no backend function or migration mentions the DMS', () => {
    const backend = [...load(['supabase/functions'], /\.(ts|js)$/), ...load(['supabase/migrations'], /\.sql$/)];
    expect(backend.length).toBeGreaterThan(0);
    expect(backend.filter((f) => DMS_WORDS.test(f.src)).map((f) => f.rel)).toEqual([]);
  });
});
