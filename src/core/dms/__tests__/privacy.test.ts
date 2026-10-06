/** @jest-environment node */
// The privacy sweep: no frame, landmark, GateToken, profile or setup record leaves the device or reaches a
// log. The native side has its own sweeps (modules/dms-vision/__tests__/native-*.test.ts: no pixels out, no
// storage, no network, logging only through DmsLog's static codes). This one covers the JavaScript side:
// 1. The DMS code (src/core/dms, modules/dms-vision/src) imports only what its group's ALLOWLIST names: a new
//    import, including an app helper that does I/O itself, fails until it is reviewed. On top of that, a
//    denylist catches direct calls and indirections: any `console` reference at all, network, storage and
//    telemetry names, and `globalThis[...]` / `global[...]`. Code only: comments may name what is forbidden.
// 2. Who imports the DMS lane: the camera bridge (src/features/camera), the focus detector and the drive
//    engine's finalize (the payload flags), each named here. The bridge files make no console, network or
//    telemetry call (the local settings table is allowed: the DMS switch, the setup date, the profile and
//    setup stores).
// 3. The profile and setup keys are written only by the host's store.
// 4. The upload contract (plan §3): the v3 payload carries `dmsOn`, `dmsFaceSeen` and the `eyes_off` /
//    `drowsy` events shaped like every other event. No camera-specific field exists: the event schema is
//    strict and its `measured` has no camera key; the finalizer names only the two flags; no DMS internal
//    (gaze, landmarks, iris, PERCLOS, the token, the profile) appears in the contract or the backend.
import { EVENT_TYPES_V3, FinalizeTripPayloadV3Schema, MeasuredV3Schema, PayloadEventV3Schema } from '@/data/sync/payload';

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
const load = (dirs: string[], ext = /\.(ts|tsx|js|jsx|mjs|cjs)$/) =>
  dirs
    .flatMap((d) => walk(path.join(ROOT, d), ext))
    .map((f) => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }))
    .filter((f) => !TEST.test(f.rel));

/** Source without comments, so a comment can neither trip nor satisfy a rule. */
export function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const DMS_FILES = load(['src/core/dms', 'modules/dms-vision/src']);

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
const MODULE_LEAVES = ['constants', 'wire', 'types', 'preview'].map((l) => `modules/dms-vision/src/${l}`);
/** The non-relative imports each group may make. */
const ALLOW: Record<string, readonly string[]> = {
  lane: ['@/core/engine/types', '@/core/engine/machine', '@scoring', 'zod'],
  // '@/core/engine/motionEvidence': the shared, pure per-row motion evidence (a function of the FeatureRow alone);
  // the host computes it when the caller passes none.
  host: ['@/core/engine/types', '@/core/engine/machine', '@/core/engine/motionEvidence', 'expo-crypto'],
  // react / react-native: the preview view's types only (preview.ts)
  module: ['expo-modules-core', 'zod', 'react', 'react-native'],
};
const groupOf = (rel: string) => (rel.startsWith('modules/') ? 'module' : rel.startsWith('src/core/dms/host/') ? 'host' : 'lane');
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

describe('1a. DMS code imports only what its group allows', () => {
  test('no lane file imports anything unlisted', () => {
    expect(DMS_FILES.map((f) => ({ f: f.rel, extra: disallowed(f.rel, f.src) })).filter((x) => x.extra.length > 0)).toEqual([]);
  });
  test.each([
    ['src/core/dms/host/setup.ts', `import { useDb } from '@/data/queries/context';`],
    ['src/core/dms/engine/engine.ts', `import { uploadTrip } from '@/data/sync/upload';`],
    ['src/core/dms/engine/engine.ts', `import { log } from '@/lib/log';`],
    ['src/core/dms/engine/engine.ts', `import DmsVision from '${['..', '..', '..', '..', 'modules', 'dms-vision'].join('/')}';`],
    ['src/core/dms/adapters/flags.ts', `import { createSettingsRepo } from '@/data/db/settings';`],
    ['modules/dms-vision/src/wire.ts', `import { x } from '../../../src/core/dms/engine/config';`],
  ])('the allowlist bites: %s ← %s', (rel, line) => {
    expect(disallowed(rel, line)).toHaveLength(1);
  });
  test('LANE groups are where the files are', () => {
    expect(DMS_FILES.every((f) => LANE.some((l) => f.rel.startsWith(l)))).toBe(true);
  });
});

describe('1. DMS code: no console, network, storage or telemetry', () => {
  test('the sweep sees the host, the setup, the engine and the wrapper', () => {
    const rels = DMS_FILES.map((f) => f.rel);
    for (const want of ['src/core/dms/host/controller.ts', 'src/core/dms/host/setup.ts', 'src/core/dms/engine/engine.ts', 'modules/dms-vision/src/index.ts', 'modules/dms-vision/src/preview.ts']) expect(rels).toContain(want);
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
  /** The camera bridge (src/features/camera): the controller's owner, the settings and setup screens' hooks. */
  const CAMERA = ['src/features/camera/bridge.ts', 'src/features/camera/defaultBridge.ts', 'src/features/camera/runtime.ts', 'src/features/camera/copy.ts', 'src/features/camera/useDmsSetup.ts', 'src/features/camera/DmsSetupScreen.tsx'];
  /** The scoring seams: the focus detector (its samples), the finalizer and the drive host's points estimate (the payload flags). */
  const SEAMS = ['src/core/detectors/focus.ts', 'src/core/engine/finalize.ts', 'src/drive/host.ts'];
  const ALLOWED = new Set([...CAMERA, ...SEAMS]);
  test('outside src/core/dms, only the camera bridge and the scoring seams, each named here', () => {
    const importers = REPO.filter((f) => !f.rel.startsWith('src/core/dms/') && /['"](?:@\/core\/dms|[./]*\/core\/dms)(?:\/[^'"]*)?['"]/.test(code(f.src))).map((f) => f.rel);
    expect(importers.filter((r) => !ALLOWED.has(r))).toEqual([]);
    for (const seam of SEAMS) expect(importers).toContain(seam);
  });
  test('the camera bridge files: no console, network or telemetry (the local settings table is allowed)', () => {
    const files = REPO.filter((f) => f.rel.startsWith('src/features/camera/'));
    expect(files.length).toBeGreaterThanOrEqual(CAMERA.length);
    const broken = files.map((f) => ({ f: f.rel, broken: breaks(f.src).filter((b) => b !== 'storage') })).filter((x) => x.broken.length > 0);
    expect(broken).toEqual([]);
  });
  test('the profile and setup keys are written only by the host’s store', () => {
    for (const key of ['dms.profile', 'dms.setup']) {
      const users = REPO.filter((f) => new RegExp(`['"]${key.replace('.', '\\.')}['"]`).test(code(f.src))).map((f) => f.rel);
      expect({ key, users }).toEqual({ key, users: ['src/core/dms/host/profileStore.ts'] });
    }
  });
  test('the focus detector consumes the DMS samples; nothing else outside the core names them', () => {
    const users = REPO.filter((f) => !f.rel.startsWith('src/core/') && !f.rel.startsWith('src/features/camera/') && /\bDmsFocusSample\b/.test(code(f.src))).map((f) => f.rel);
    expect(users).toEqual([]);
  });
});

describe('3. the upload contract (plan §3): two booleans and two ordinary event types, nothing camera-specific', () => {
  const read = (rel: string) => code(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const DMS_INTERNAL = /\b(gaze\w*|landmarks?|iris\w*|perclos|gatetoken|dmsprofile|dms\.setup|dms\.profile)\b/i;
  const uuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const event = (over: Record<string, unknown> = {}) => ({ id: uuid, type: 'eyes_off', tier: 'minor', startedAt: 1_760_000_010_000, durationS: 2.5, lat: null, lng: null, measured: { speedMph: 34.5 }, ...over });

  test('eyes_off and drowsy are event types like every other; no focus or camera type exists', () => {
    expect(EVENT_TYPES_V3).toContain('eyes_off');
    expect(EVENT_TYPES_V3).toContain('drowsy');
    expect(EVENT_TYPES_V3.filter((t) => /focus|camera|glance|dms/i.test(t))).toEqual([]);
  });
  test('an event’s measured carries no camera field: glanceS, focusKind, q and the like are refused (strict)', () => {
    expect(PayloadEventV3Schema.safeParse(event()).success).toBe(true);
    for (const extra of [{ glanceS: 2.5 }, { focusKind: 'glance' }, { q: 0.9 }, { gazeYaw: 10 }, { zone: 'lap' }]) {
      expect({ extra, ok: PayloadEventV3Schema.safeParse(event({ measured: { speedMph: 30, ...extra } })).success }).toEqual({ extra, ok: false });
    }
    expect(PayloadEventV3Schema.safeParse({ ...event(), source: 'camera' }).success).toBe(false);
    expect(Object.keys(MeasuredV3Schema.shape).sort()).toEqual(['limitMph', 'mounted', 'peakG', 'speedMph']);
  });
  test('the payload names dmsOn and dmsFaceSeen as booleans, and nothing else DMS-related', () => {
    const shape = Object.keys(FinalizeTripPayloadV3Schema.shape);
    expect(shape.filter((k) => /dms|camera|focus|glance|drows/i.test(k)).sort()).toEqual(['dmsFaceSeen', 'dmsOn']);
    const base = { v: 3, clientTripId: uuid, startedAt: 1_760_000_000_000, endedAt: 1_760_000_600_000, tz: 'America/New_York', localDay: '2025-10-09', miles: 5, safeMiles: 5, nightMiles: 0, durationS: 600, start: null, end: null, polyline: '', integrity: { mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 40 }, events: [], appVersion: '3.0.0' };
    expect(FinalizeTripPayloadV3Schema.safeParse({ ...base, dmsOn: true, dmsFaceSeen: true }).success).toBe(true);
    expect(FinalizeTripPayloadV3Schema.safeParse({ ...base, dmsOn: 1, dmsFaceSeen: true }).success).toBe(false);
    expect(FinalizeTripPayloadV3Schema.safeParse({ ...base, dmsOn: true }).success).toBe(false);
  });
  test('the trip finaliser names only the two flags (and the share counters that make them)', () => {
    const WATCH = /\b\w*(?:camera|focus|drowsi|glance|attention|dms|gaze|landmark|iris|perclos|gatetoken)\w*\b/gi;
    const watched = [...new Set([...read('src/core/engine/finalize.ts').matchAll(WATCH)].map((m) => m[0]))].sort();
    expect(watched).toEqual(['dms', 'dmsFaceRows', 'dmsFaceSeen', 'dmsOn', 'dmsPayloadFlags', 'dms_face_seen', 'dms_on']);
  });
  test('no DMS internal (gaze, landmarks, iris, PERCLOS, the token, the profile or setup record) in the contract or the backend', () => {
    const backend = [...load(['supabase/functions'], /\.(ts|js)$/).filter((f) => !f.rel.includes('/testing/')), ...load(['supabase/migrations'], /\.sql$/)];
    expect(backend.length).toBeGreaterThan(0);
    const all = [...backend, ...['src/data/sync/payload.ts', 'src/core/engine/finalize.ts'].map((rel) => ({ rel, src: read(rel) }))];
    expect(all.filter((f) => DMS_INTERNAL.test(code(f.src))).map((f) => f.rel)).toEqual([]);
  });
});
