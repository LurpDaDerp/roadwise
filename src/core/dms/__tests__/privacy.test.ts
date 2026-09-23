/** @jest-environment node */
// The privacy sweep (plan Task 15; plan "Privacy"): no frame, landmark, GateToken or profile leaves the device
// or reaches a log. The native side has its own sweeps (modules/dms-vision/__tests__/native-*.test.ts: no
// pixels out, no storage, no network, logging only through DmsLog's static codes). This one covers the
// JavaScript side:
// 1. The DMS code (src/core/dms, modules/dms-vision/src, the dev panel and its route) imports only what its
//    group's ALLOWLIST names (T16 r3, security m-1): a new import, including an app helper that does I/O
//    itself, fails until it is reviewed. On top of that, a denylist catches direct calls and indirections:
//    any `console` reference at all, network, storage and telemetry names, and `globalThis[...]` / `global[...]`.
//    Code only: comments may name what is forbidden. (The panel reads the signed-in profile's age band through
//    the session hook and the stored flag through appConfig: reads of what the app already holds.)
// 2. Nothing else in the repo imports the DMS lane yet, except the dev panel; M7 will add itself here under
//    review (its uploads need a disclosure and consent first: README, "Where the data may go").
// 3. The profile's settings key is written only by the profile store.
// 4. The upload contract (T16 r3, security I-1). The DMS's own words (gaze, landmarks, iris, PERCLOS, the
//    GateToken, the profile) appear nowhere in it or in the backend. What IS camera-derived is pinned by name,
//    and anything new fails: a trip event with source 'camera', `measured.glanceS`, `measured.focusKind`
//    ('glance' | 'drowsiness'), its lat/lng rounded to 3 dp, `trips.camera_session` and the daily
//    `camera_day`. Passing `cameraFocus` to the drive engine uploads those (README, "Where the data may go").

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
const load = (dirs: string[], ext = /\.(ts|tsx|js|jsx|mjs|cjs)$/) => // final review n-2: JavaScript sources too
  dirs
    .flatMap((d) => walk(path.join(ROOT, d), ext))
    .map((f) => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }))
    .filter((f) => !TEST.test(f.rel));

/** Source without comments, so a comment can neither trip nor satisfy a rule. */
export function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const DMS_FILES = [...load(['src/core/dms', 'modules/dms-vision/src']), ...['src/features/dev/DmsDiagnosticsPanel.tsx', 'app/(app)/dev/dms.tsx'].map((rel) => ({ rel, src: fs.readFileSync(path.join(ROOT, rel), 'utf8') }))];

/** What DMS code must never call or import (the denylist, over the allowlist below). */
export const FORBIDDEN: [string, RegExp][] = [
  ['console', /\bconsole\b/],
  ['network', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\baxios\b|\bsendBeacon\b|['"]@supabase\/|['"]@\/data\/supabase\/(?!session['"])|['"]@\/data\/sync|\bglobalThis\s*\[|\bglobal\s*\[/],
  ['storage', /\bAsyncStorage\b|\bSecureStore\b|['"]expo-secure-store['"]|['"]expo-file-system|\bFileSystem\b|\blocalStorage\b|\bsessionStorage\b|\bMMKV\b|['"]expo-sqlite['"]|['"]@\/data\/db/],
  ['telemetry', /\bSentry\b|['"]@sentry\/|\bcaptureException\b|\banalytics\b|\btrackEvent\b/],
];

/** The rules a source breaks. */
export function breaks(src: string): string[] {
  const c = code(src);
  return FORBIDDEN.filter(([, re]) => re.test(c)).map(([name]) => name);
}

/** Every module specifier in a source (as imports.test.ts reads them), comments stripped. */
export function specifiers(src: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\brequireActual\s*(?:<[^>]*>)?\s*\(\s*)(['"])([^'"\n]+)\1/g;
  return [...code(src).matchAll(re)].map((m) => m[2]!);
}
const LANE = ['src/core/dms/', 'modules/dms-vision/src/'];
const MODULE_LEAVES = ['constants', 'wire', 'types'].map((l) => `modules/dms-vision/src/${l}`);
/** The non-relative imports each group may make (T16 r3, security m-1). */
const ALLOW: Record<string, readonly string[]> = {
  lane: ['@/core/engine/types', '@/core/engine/machine', '@scoring', 'zod'],
  host: ['@/core/engine/types', '@/core/engine/machine', 'expo-crypto'],
  module: ['expo-modules-core', 'zod'],
  panel: ['react', 'react-native', 'expo-router', '@/ui', '@/core/dms', '@/core/engine/types', '@/data/config/appConfig', '@/data/queries/context', '@/data/supabase/session'],
  route: ['react', 'expo-router', '@/features/dev/DmsDiagnosticsPanel', '@/features/dev/flags'],
};
const groupOf = (rel: string) =>
  rel === 'src/features/dev/DmsDiagnosticsPanel.tsx' ? 'panel' : rel === 'app/(app)/dev/dms.tsx' ? 'route' : rel.startsWith('modules/') ? 'module' : rel.startsWith('src/core/dms/host/') ? 'host' : 'lane';
/** The specifiers a lane file may not import. */
export function disallowed(rel: string, src: string): string[] {
  const group = groupOf(rel);
  return specifiers(src).filter((spec) => {
    if (ALLOW[group]!.includes(spec)) return false;
    if (!spec.startsWith('.')) return true;
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, rel), '..', spec)).replace(/\\/g, '/');
    if (group === 'module') return !target.startsWith('modules/dms-vision/src/');
    if (target.startsWith('src/core/dms/')) return false;
    if (MODULE_LEAVES.includes(target)) return false;
    // The wrapper itself: only the host's binding (imports.test.ts enforces who).
    return !(group === 'host' && target === 'modules/dms-vision');
  });
}

describe('1a. DMS code imports only what its group allows (T16 r3, security m-1)', () => {
  test('no lane file imports anything unlisted', () => {
    expect(DMS_FILES.map((f) => ({ f: f.rel, extra: disallowed(f.rel, f.src) })).filter((x) => x.extra.length > 0)).toEqual([]);
  });
  test.each([
    ['src/core/dms/host/shadow.ts', `import { useDb } from '@/data/queries/context';`],
    ['src/core/dms/engine/engine.ts', `import { uploadTrip } from '@/data/sync/upload';`],
    ['src/core/dms/engine/engine.ts', `import { log } from '@/lib/log';`],
    ['src/core/dms/engine/engine.ts', `import DmsVision from '${['..', '..', '..', '..', 'modules', 'dms-vision'].join('/')}';`],
    ['src/features/dev/DmsDiagnosticsPanel.tsx', `import { settle } from '@/features/rewards/api';`],
    ['modules/dms-vision/src/wire.ts', `import { x } from '../../../src/core/dms/engine/config';`],
  ])('the allowlist bites: %s ← %s', (rel, line) => {
    expect(disallowed(rel, line)).toHaveLength(1);
  });
  test('LANE groups are where the files are', () => {
    expect(DMS_FILES.every((f) => LANE.some((l) => f.rel.startsWith(l)) || ['panel', 'route'].includes(groupOf(f.rel)))).toBe(true);
  });
});

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
  test.each([
    ['console', `const c = console; c.log(frame);`],
    ['network', `globalThis['fet' + 'ch'](url);`],
  ])('indirections are caught (%s): %s', (rule, line) => {
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

describe('3. the upload contract: the DMS-derived surface is pinned by name (T16 r3, security I-1)', () => {
  const read = (rel: string) => code(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  /** Every identifier in a source that names camera, focus, drowsiness, glance, attention or a DMS internal. */
  const WATCH = /\b\w*(?:camera|focus|drowsi|glance|attention|dms|gaze|landmark|iris|perclos|gatetoken)\w*\b/gi;
  const watched = (src: string) => [...new Set([...src.matchAll(WATCH)].map((m) => m[0]))].sort();
  const DMS_INTERNAL = /\b(dms\w*|gaze\w*|landmarks?|iris\w*|perclos|gatetoken|dmsprofile)\b/i;

  test('the client and server payload schemas name exactly the pinned camera-derived fields', () => {
    // source 'camera' (trip_events), measured.glanceS, measured.focusKind 'glance' | 'drowsiness', the focus
    // category and its deduction, trips.cameraSession.
    const PINNED = ['camera', 'cameraSession', 'drowsiness', 'focus', 'focusKind', 'glance', 'glanceS'];
    for (const rel of ['src/data/sync/payload.ts', 'supabase/functions/_shared/payload.ts']) expect({ rel, watched: watched(read(rel)) }).toEqual({ rel, watched: PINNED });
  });
  test('the event carrying them keeps its location to 3 dp, and focusKind has exactly two values', () => {
    for (const rel of ['src/data/sync/payload.ts', 'supabase/functions/_shared/payload.ts']) {
      const src = read(rel);
      expect(src).toMatch(/refine\(\(e\) => roundedTo3dp\(e\.lat\) && roundedTo3dp\(e\.lng\)/);
      expect(src).toMatch(/focusKind: z\.enum\(\['glance', 'drowsiness'\]\)/);
      expect(src).toMatch(/source: z\.enum\(\['gnss', 'imu', 'both', 'os', 'camera'\]\)/);
    }
  });
  test('the trip finaliser names only the camera session (and the camera-seat reason)', () => {
    expect(watched(read('src/core/engine/finalize.ts'))).toEqual(['cameraFaceDriverSeat', 'cameraSession', 'camera_session']);
  });
  test('the migrations name only camera_session, camera_day, the camera consent, the flag and the source check', () => {
    const sql = load(['supabase/migrations'], /\.sql$/).map((f) => f.src).join('\n');
    expect([...new Set([...sql.matchAll(/\b\w*camera\w*\b/gi)].map((m) => m[0]))].sort()).toEqual(['camera', 'cameraDay', 'cameraSession', 'camera_beta', 'camera_day', 'camera_session']);
  });
  test('the backend functions name only the same camera fields', () => {
    const fns = load(['supabase/functions'], /\.(ts|js)$/).filter((f) => !f.rel.includes('/testing/'));
    const names = [...new Set(fns.flatMap((f) => [...code(f.src).matchAll(/\b\w*camera\w*\b/gi)].map((m) => m[0])))].sort();
    expect(names).toEqual(['camera', 'cameraDay', 'cameraGood', 'cameraSession', 'camera_day', 'camera_session']);
  });
  test('no DMS internal (gaze, landmarks, iris, PERCLOS, the token, the profile) in the contract or the backend', () => {
    const backend = [...load(['supabase/functions'], /\.(ts|js)$/), ...load(['supabase/migrations'], /\.sql$/)];
    expect(backend.length).toBeGreaterThan(0);
    const all = [...backend, ...['src/data/sync/payload.ts', 'src/core/engine/finalize.ts'].map((rel) => ({ rel, src: read(rel) }))];
    expect(all.filter((f) => DMS_INTERNAL.test(f.src)).map((f) => f.rel)).toEqual([]);
  });
  test('the pin bites: a new camera-derived field in the payload fails', () => {
    const mutated = read('src/data/sync/payload.ts').replace('glanceS: nonNegative.optional(),', 'glanceS: nonNegative.optional(),\n    gazeYaw: z.number().optional(),');
    expect(watched(mutated)).toContain('gazeYaw');
  });
});
