// The README contract (plan Task 15): src/core/dms/README.md is the prose half of the bridge M7 plugs into,
// and it must list exactly what the code has. The native module's README has its own contract test
// (modules/dms-vision/__tests__/contract.test.ts: the wire, methods, events, error codes and timings).
// The TypeScript side of each list below is exhaustive by construction (`satisfies Record<Union, true>`),
// so a new status reason, event kind or gate input fails here until the README names it.
import { createFakeDmsVision } from '../../../../modules/dms-vision/src/fake';
import { ALERT_KINDS } from '../engine/alerts';
import type { DmsEvent } from '../engine/engine';
import { createDmsController, type DmsGateInputs, type DmsHudStatus } from '../host/controller';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

/** The section of the README under `## title`, up to the next `## `. */
function section(title: string): string {
  const start = README.indexOf(`\n## ${title}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = README.indexOf('\n## ', start + 4);
  return README.slice(start, end < 0 ? undefined : end);
}
/** The backticked names on the README line that starts with `label`. */
function listed(label: string): string[] {
  const line = README.split('\n').find((l) => l.startsWith(label));
  expect(line).toBeDefined();
  return [...new Set([...line!.matchAll(/`([\w.]+)`/g)].map((m) => m[1]!))].sort();
}
const keys = (r: Record<string, true>) => Object.keys(r).sort();

const GATE_INPUTS = {
  optedIn: true,
  cameraBeta: true,
  ageBand: true,
  driveActive: true,
  mode: true,
  role: true,
  appActive: true,
  driverSide: true,
  sensitivity: true,
  alerts: true,
} satisfies Record<keyof DmsGateInputs, true>;
const CAMERA = { off: true, starting: true, active: true, limited: true, paused: true } satisfies Record<DmsHudStatus['camera'], true>;
const REASONS = {
  not_opted_in: true,
  flag_off: true,
  age: true,
  no_drive: true,
  mode: true,
  role: true,
  app_inactive: true,
  permission: true,
  error: true,
  busy: true,
  interrupted: true,
  thermal: true,
  low_light: true,
  stopped: true,
  face_lost: true,
  eyes_not_visible: true,
} satisfies Record<NonNullable<DmsHudStatus['reason']>, true>;
const EVENTS = {
  d1_warning: true,
  d1_rearmed: true,
  d2_warning: true,
  d2_reset: true,
  d3_phone_pattern: true,
  d4_unresponsive: true,
  glance_end: true,
  microsleep: true,
  sleep: true,
  unresponsive: true,
  blink: true,
  episode_end: true,
  nod: true,
  microsleep_nod: true,
  yawn: true,
  calibrated: true,
  provisional: true,
  uncalibrated: true,
  camera_bump: true,
  driver_change: true,
  baseline_reset: true,
  warm_start: true,
  fatigue_minute: true,
} satisfies Record<DmsEvent['kind'], true>;

test('the Calls table names every controller method (idle is for tests only)', () => {
  const calls = section('Calls');
  const named = new Set<string>();
  for (const m of calls.matchAll(/^\| ([^|]+)\|/gm)) for (const n of m[1]!.matchAll(/`(\w+)\(/g)) named.add(n[1]!);
  const ctl = createDmsController({ native: createFakeDmsVision(), onAlert: () => {}, onStatus: () => {}, profileStore: { load: async () => null, save: async () => {}, clear: async () => {} }, random: () => 'n' });
  expect([...named].sort()).toEqual(Object.keys(ctl).filter((k) => k !== 'idle').sort());
});

test('the gate inputs are exactly DmsGateInputs', () => {
  const s = section('Gate inputs');
  const named = [...s.matchAll(/^- \*\*([^*]+)\*\*/gm)].flatMap((m) => [...m[1]!.matchAll(/`(\w+)`/g)].map((n) => n[1]!));
  expect(named.filter((n) => n in GATE_INPUTS).sort()).toEqual(keys(GATE_INPUTS));
  expect(named.filter((n) => !(n in GATE_INPUTS) && !['mounted', 'driver', 'live', 'shadow'].includes(n))).toEqual([]);
});

test('the status: camera values and reasons', () => {
  expect(listed('- **Camera values:**')).toEqual(keys(CAMERA));
  expect(listed('- **Reasons:**')).toEqual(keys(REASONS));
});

test('the alert kinds are exactly ALERT_KINDS', () => {
  const s = section('Alerts');
  const named = [...s.matchAll(/^- \*\*Tier \d[^*]*\*\*([^\n]*)/gm)].flatMap((m) => [...m[1]!.matchAll(/`(\w+)`/g)].map((n) => n[1]!)).filter((n) => !['once', 'start', 'stop', 'heat', 'dark', 'fault'].includes(n));
  expect(named.sort()).toEqual([...ALERT_KINDS].sort());
});

test('the event kinds are exactly DmsEvent’s', () => {
  expect(listed('- **Event kinds:**')).toEqual(keys(EVENTS));
});

test('M7 is told to use the host-owned binding, never the wrapper', () => {
  expect(README).toMatch(/createDefaultDmsController\(/);
  expect(README).not.toMatch(/native: DmsVision/);
});

test('T16 r3 (security I-1): the README says what passing cameraFocus uploads, and the M7 carries that gate it', () => {
  const s = section('Where the data may go');
  expect(s).toMatch(/`cameraFocus`[^\n]*\bis an upload\b/);
  for (const field of ["source 'camera'", '`glanceS`', '`focusKind`', '3 dp', '`camera_session`', '`camera_day`']) expect(s).toContain(field);
  expect(s).toMatch(/per trip[^\n]*A10 disclosure[^\n]*versioned camera consent|A10 disclosure[^\n]*versioned camera consent[^\n]*per trip/);
  expect(s).toMatch(/guardian[^\n]*camera-sourced events/i);
});

test('T16 r3 (seat T14 Round 2): M7 maps busy to "camera in use by diagnostics"', () => {
  expect(README).toMatch(/`busy`[^\n]*camera in use by diagnostics/);
});
