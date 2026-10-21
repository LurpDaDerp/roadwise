/**
 * Mechanical proof of "one permission system, one notification plumbing, one drive host": a drive
 * starts from the Start card (both platforms) or from the iPhone's native drive detector, and JS
 * runs no detection of its own in the background (modes plan §3.1, js-lifecycle §4.1). Every source
 * file under `src/` and `app/` (tests and fixtures excluded) is read with its comments stripped, and:
 *
 * - no file outside `src/core/permissions` names `requestForegroundPermissionsAsync`,
 *   `requestPermissionsAsync`, `requestMotionPermission` or the detector's `requestAlways`;
 * - only `src/boot/autoDetect.ts` arms or disarms the detector (`.setArmed(`), and only the drive
 *   host (`src/drive/host.ts`) runs the Start-card wait, "Not driving?" and the journal
 *   (`.startWaiting(`, `.extendWaiting(`, `.notDriving(`, `.readRows(`, `.discardDrive(`,
 *   `.listDrives(`; the developer diagnostics may list the journal, read-only);
 * - nothing outside the drive host dispatches an engine `start`;
 * - the retired forgot-to-start reminder is only switched off, once, by the bootstrap
 *   (`setTripReminder`, also named in the drive source's type), and its other names are gone;
 * - no file names anything that detects a trip in JS: background location
 *   (`requestBackgroundPermissionsAsync`, `startLocationUpdatesAsync`), geofences and
 *   significant-location changes, background tasks (`TaskManager`, `defineTask`,
 *   `registerTaskAsync`, `BackgroundFetch`), the old auto-record switch (`setAutoDetect`) or the old
 *   reminder (`setForgotToStartReminder`, `checkForgottenDrive`); and `package.json` carries no
 *   background-task package. The iPhone's detection is native (drive-sense) and hands JS a drive;
 * - the notification plumbing names nothing that starts a drive and imports nothing of the drive
 *   but its types; Home reads no link parameter; no JS sets notification categories;
 * - only `src/features/notifications` names `setNotificationHandler` or
 *   `addNotificationResponseReceivedListener`;
 * - M3's interim detection screen, its `/detection` route, the auto-record route and the
 *   reminder's files are gone.
 *
 * A name is matched as a whole identifier anywhere in code (a call, a reference or a destructure),
 * so passing `Location.requestForegroundPermissionsAsync` along uncalled is caught too; a method
 * whose name is also a word elsewhere (`notDriving` is a module and a settings key) is matched as a
 * member call. The scanner is checked against planted sources first (the negative control).
 */
// The app's tsconfig carries no Node types: local shapes, as the repo's other Node reads do.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const fs = require('node:fs') as {
  readdirSync(dir: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  readFileSync(file: string, enc: 'utf8'): string;
  existsSync(file: string): boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const path = require('node:path') as { join(...parts: string[]): string; relative(a: string, b: string): string };

// Jest compiles this suite to CommonJS, so `__dirname` is real at run time.
declare const __dirname: string;
const ROOT = path.join(__dirname, '..', '..');

interface Rule {
  name: string;
  /** Whole-identifier names this rule forbids. */
  names?: readonly string[];
  /** Methods this rule forbids calling (`.name(`), for names that are also words elsewhere. */
  calls?: readonly string[];
  /** Code shapes this rule forbids, each with the label a violation reports. */
  patterns?: readonly { label: string; re: RegExp }[];
  /** Repo-relative, forward-slash path prefixes where the names are allowed. */
  allowed: readonly string[];
  /** When set, the rule applies only to files under these prefixes (else everywhere). */
  scope?: readonly string[];
}

/** Names of background drive and trip detection in JS; allowed nowhere. */
export const FORBIDDEN_DETECTION: readonly string[] = [
  'setAutoDetect',
  'requestBackgroundPermissionsAsync',
  'startLocationUpdatesAsync',
  'startGeofencingAsync',
  'defineTask',
  'registerTaskAsync',
  'BackgroundFetch',
  'TaskManager',
  'startMonitoringSignificantLocationChanges',
  'checkForgottenDrive',
  'setForgotToStartReminder',
];

/** The retired forgot-to-start reminder's names, other than its one switch-off; allowed nowhere. */
export const RETIRED_REMINDER: readonly string[] = [
  'getTripReminderStatus',
  'requestReminderLocation',
  'requestAlwaysForReminder',
  'claimReminderTap',
  'takeReminderTap',
  'startFromReminderTap',
  'watchReminderTapIntents',
  'reminderOff',
];

/** The detector's methods only the drive host calls. */
export const HOST_ONLY_DETECT: readonly string[] = ['startWaiting', 'extendWaiting', 'notDriving', 'readRows', 'discardDrive'];

/** What could start a drive from JS (the drive host and every way to reach it). */
export const DRIVE_STARTERS: readonly string[] = [
  'startCapture',
  'useDriveControls',
  'nativeDriveSource',
  'useDriveHost',
  'DriveContext',
  'DriveProvider',
  'createDriveHost',
];

/** Repo paths the notification plumbing may not import a value from: the drive, the drive screens, Home. */
export const PLUMBING_FORBIDDEN_MODULES: readonly string[] = ['src/drive', 'src/features/drive', 'src/features/home'];

/** The notification plumbing. */
export const NOTIFICATION_FILES: readonly string[] = ['src/features/notifications/'];

/** The one Home module the notification plumbing may import a value from: the start notice (words only). */
export const NOTIFICATION_ALLOWED_MODULES: readonly string[] = ['src/features/home/startNotice'];

/** Every module specifier in `from '…'`, `import '…'`, `import('…')` and `require('…')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g;

/** A specifier as a repo path (`@/x` is `src/x`; `./` and `../` from the importing file), or null for a package. */
export function resolveSpecifier(file: string, spec: string): string | null {
  let joined: string;
  if (spec.startsWith('@/')) joined = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) joined = `${file.split('/').slice(0, -1).join('/')}/${spec}`;
  else return null;
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Packages that run JS in the background with no drive open; none may be a dependency. */
export const FORBIDDEN_PACKAGES: readonly string[] = ['expo-task-manager', 'expo-background-fetch', 'expo-background-task'];

export const RULES: readonly Rule[] = [
  {
    name: 'OS permission requests only in the permission adapter (rev1: I3)',
    names: ['requestForegroundPermissionsAsync', 'requestPermissionsAsync', 'requestMotionPermission', 'requestAlways'],
    allowed: ['src/core/permissions/'],
  },
  {
    // Signed in and onboarded with the permissions it needs, the iPhone arms its detector; signed
    // out, switched or deleted, it disarms. One module decides.
    name: 'only src/boot/autoDetect.ts arms or disarms the drive detector',
    calls: ['setArmed'],
    allowed: ['src/boot/autoDetect.ts'],
  },
  {
    name: 'only the drive host runs the Start-card wait, "Not driving?" and the journal',
    calls: HOST_ONLY_DETECT,
    allowed: ['src/drive/host.ts'],
  },
  {
    // Listing the journal changes nothing; the developer diagnostics show it.
    name: 'only the drive host (and the diagnostics, read-only) lists the journal',
    calls: ['listDrives'],
    allowed: ['src/drive/host.ts', 'src/features/dev/DriveDiagnosticsScreen.tsx'],
  },
  {
    name: 'nothing outside the drive host starts the engine',
    patterns: [{ label: "dispatch({ type: 'start' })", re: /\bdispatch\s*\(\s*\{\s*type\s*:\s*['"`]start['"`]/ }],
    allowed: ['src/drive/host.ts'],
  },
  {
    // The bootstrap turns an older install's reminder off once (`reminder.retired`); the drive
    // source's type names the optional method it calls.
    name: 'the retired forgot-to-start reminder is only switched off, by the bootstrap',
    names: ['setTripReminder'],
    allowed: ['src/boot/bootstrap.ts', 'src/drive/source.ts'],
  },
  {
    name: "the retired reminder's other names are gone",
    names: RETIRED_REMINDER,
    allowed: [],
  },
  {
    name: 'the notification plumbing cannot reach the drive by itself',
    names: DRIVE_STARTERS,
    allowed: [],
    scope: NOTIFICATION_FILES,
  },
  {
    // A notification tap or a link opens Home; Home starts nothing from what opened it.
    name: 'Home never reads a link parameter',
    names: ['useLocalSearchParams', 'useGlobalSearchParams', 'useSearchParams'],
    allowed: [],
    scope: ['app/(tabs)/home.tsx', 'src/features/home/'],
  },
  {
    // No RoadWise notification has buttons (PRODUCT.md). A category set from JS would add buttons
    // nothing handles.
    name: 'no JS notification categories',
    names: ['setNotificationCategoryAsync'],
    allowed: [],
  },
  {
    // JS watches for nothing in the background: the iPhone's detector is native and hands JS a
    // drive; Android drives start from the Start card. Crash recovery (`adopt`) and the journal
    // only continue a drive that already started.
    name: 'no background drive detection in JS',
    names: FORBIDDEN_DETECTION,
    allowed: [],
  },
  {
    name: 'one notification handler and one response listener (rev1: C1)',
    names: ['setNotificationHandler', 'addNotificationResponseReceivedListener'],
    allowed: ['src/features/notifications/'],
  },
];

/** Source with comments removed; strings and template literals kept (a URL's `//` is not a comment). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export interface Violation {
  rule: string;
  file: string;
  name: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The forbidden packages `pkg` depends on, in any dependency list, sorted. */
export function forbiddenPackages(pkg: PackageJson): string[] {
  const all = new Set(
    [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies].flatMap((d) => Object.keys(d ?? {}))
  );
  return FORBIDDEN_PACKAGES.filter((name) => all.has(name)).sort();
}

/** Every rule broken by `files` (repo-relative path → source). */
export function scan(files: Readonly<Record<string, string>>, rules: readonly Rule[] = RULES): Violation[] {
  const found: Violation[] = [];
  for (const [file, source] of Object.entries(files)) {
    const code = stripComments(source);
    for (const rule of rules) {
      if (rule.scope && !rule.scope.some((prefix) => file.startsWith(prefix))) continue;
      if (rule.allowed.some((prefix) => file.startsWith(prefix))) continue;
      for (const name of rule.names ?? []) {
        if (new RegExp(`(^|[^A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`).test(code)) found.push({ rule: rule.name, file, name });
      }
      for (const name of rule.calls ?? []) {
        if (new RegExp(`\\.\\s*${name}\\s*\\(`).test(code)) found.push({ rule: rule.name, file, name });
      }
      for (const p of rule.patterns ?? []) {
        if (p.re.test(code)) found.push({ rule: rule.name, file, name: p.label });
      }
    }
  }
  return found;
}

/** Whether `target` is `mod` or under it. */
const within = (target: string, mod: string): boolean => target === mod || target.startsWith(`${mod}/`);

/** `import type …` and `export type … from` statements: erased at build, so they reach nothing at run time. */
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*(['"`])[^'"`]+\1/g;

/**
 * The notification files that import a value (types are fine: they are erased) from the drive, the
 * drive screens or Home (the start notice excepted).
 */
export function notificationImports(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([file, src]) => {
      if (!NOTIFICATION_FILES.some((p) => file.startsWith(p))) return false;
      const code = stripComments(src).replace(TYPE_ONLY, '');
      return [...code.matchAll(SPECIFIER)].some((m) => {
        const target = resolveSpecifier(file, m[2] as string);
        if (target === null) return false;
        if (NOTIFICATION_ALLOWED_MODULES.some((mod) => within(target, mod))) return false;
        return PLUMBING_FORBIDDEN_MODULES.some((mod) => within(target, mod));
      });
    })
    .map(([file]) => file);
}

const SOURCE = /\.(ts|tsx)$/;
const SKIPPED_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__', 'node_modules']);

function sources(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sources(full, out);
      continue;
    }
    if (!SOURCE.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    out[path.relative(ROOT, full).split('\\').join('/')] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

const found = (files: Readonly<Record<string, string>>): string[] => scan(files).map((v) => `${v.file}:${v.name}`);

describe('the scanner (negative control)', () => {
  test('finds a planted call, a reference passed along uncalled, a destructure and a computed call', () => {
    const planted = {
      'src/features/drive/x.ts': 'await Location.requestForegroundPermissionsAsync();',
      'src/features/drive/y.ts': 'const deps = { request: Location.requestBackgroundPermissionsAsync };',
      'app/z.tsx': "const { requestMotionPermission } = DriveSense; Notifications.requestPermissionsAsync({});",
      'src/features/home/w.ts': 'Notifications.setNotificationHandler(null); N.addNotificationResponseReceivedListener(f);',
      'src/features/onboarding/v.ts': 'await DriveDetect.requestAlways();',
      // A `//` inside a string is not a comment, and a name in a string (a computed call) counts.
      'src/features/trips/u.ts': "const u = 'http://x'; N['setNotificationHandler'](h);",
      'app/(app)/permissions/auto-record.tsx': 'await host.setAutoDetect(true);',
      // Detection is allowed nowhere: not in the permission adapter, the drive host or bootstrap.
      'src/core/permissions/adapters.ts': 'await deps.location.requestBackgroundPermissionsAsync();',
      'src/drive/host.ts': "TaskManager.defineTask('drive', f); await Location.startLocationUpdatesAsync('drive', {});",
      'src/boot/bootstrap.ts': "await Location.startGeofencingAsync('home', []); await BackgroundFetch.registerTaskAsync('t');",
      'app/_layout.tsx': 'await DriveSense.checkForgottenDrive(0); await DriveSense.setForgotToStartReminder(true);',
      'src/features/home/s.ts': 'manager.startMonitoringSignificantLocationChanges();',
    };
    expect(found(planted)).toEqual([
      'src/features/drive/x.ts:requestForegroundPermissionsAsync',
      'src/features/drive/y.ts:requestBackgroundPermissionsAsync',
      'app/z.tsx:requestPermissionsAsync',
      'app/z.tsx:requestMotionPermission',
      'src/features/home/w.ts:setNotificationHandler',
      'src/features/home/w.ts:addNotificationResponseReceivedListener',
      'src/features/onboarding/v.ts:requestAlways',
      'src/features/trips/u.ts:setNotificationHandler',
      'app/(app)/permissions/auto-record.tsx:setAutoDetect',
      'src/core/permissions/adapters.ts:requestBackgroundPermissionsAsync',
      'src/drive/host.ts:startLocationUpdatesAsync',
      'src/drive/host.ts:defineTask',
      'src/drive/host.ts:TaskManager',
      'src/boot/bootstrap.ts:startGeofencingAsync',
      'src/boot/bootstrap.ts:registerTaskAsync',
      'src/boot/bootstrap.ts:BackgroundFetch',
      'app/_layout.tsx:checkForgottenDrive',
      'app/_layout.tsx:setForgotToStartReminder',
      'src/features/home/s.ts:startMonitoringSignificantLocationChanges',
    ]);
  });

  test('the detector rules: arming only in autoDetect, the wait, "Not driving?" and the journal only in the host, an engine start only in the host', () => {
    const planted = {
      'src/features/settings/a.ts': "await DriveDetect.setArmed(true, uid);",
      'src/features/drive/b.tsx': 'await detect.startWaiting(); await detect.extendWaiting(); await DriveDetect.notDriving();',
      'src/boot/bootstrap.ts': "const drives = await detect.listDrives(); await detect.readRows(id, 0, 300); await detect.discardDrive(id);",
      'src/core/engine/recovery.ts': "await engine.dispatch({ type: 'start', ts, origin: 'manual' });",
      // fine: the owners, the diagnostics' read-only list, the words elsewhere
      'src/boot/autoDetect.ts': "await detect.setArmed(false, owner);",
      'src/drive/host.ts': "await detect.startWaiting(); await d.notDriving(); await d.readRows(id, 0, 300); await d.discardDrive(id); await engine.dispatch({ type: 'start', ts });",
      'src/features/dev/DriveDiagnosticsScreen.tsx': 'const journal = await det.listDrives();',
      'src/boot/device.ts': "import { NOT_DRIVING_KEY } from '@/drive/notDriving'; const notDriving = 1;",
      'src/features/drive/ok.tsx': "controls.cancelWaiting(); engine.dispatch({ type: 'row', row });",
    };
    expect(found(planted)).toEqual([
      'src/features/settings/a.ts:setArmed',
      'src/features/drive/b.tsx:startWaiting',
      'src/features/drive/b.tsx:extendWaiting',
      'src/features/drive/b.tsx:notDriving',
      'src/boot/bootstrap.ts:readRows',
      'src/boot/bootstrap.ts:discardDrive',
      'src/boot/bootstrap.ts:listDrives',
      "src/core/engine/recovery.ts:dispatch({ type: 'start' })",
    ]);
  });

  test("the retired reminder: switched off only by the bootstrap, its other names nowhere", () => {
    const planted = {
      'src/features/settings/r.ts': 'await DriveSense.setTripReminder(true); await DriveSense.getTripReminderStatus();',
      'src/features/notifications/t.ts': "await DriveSense.claimReminderTap('tok'); const tap = await DriveSense.takeReminderTap();",
      'app/_layout.tsx': 'void startFromReminderTap(hold, deps); watchReminderTapIntents(f);',
      'src/core/permissions/adapters.ts': 'await port.requestReminderLocation(); await adapter.requestAlwaysForReminder();',
      'src/boot/device.ts': 'await reminderOff();',
      // fine: the retirement and the source's type
      'src/boot/bootstrap.ts': 'await source.setTripReminder?.(false);',
      'src/drive/source.ts': "type T = Partial<Pick<DriveSenseApi, 'setTripReminder'>>;",
    };
    expect(found(planted)).toEqual([
      'src/features/settings/r.ts:setTripReminder',
      'src/features/settings/r.ts:getTripReminderStatus',
      'src/features/notifications/t.ts:claimReminderTap',
      'src/features/notifications/t.ts:takeReminderTap',
      'app/_layout.tsx:startFromReminderTap',
      'app/_layout.tsx:watchReminderTapIntents',
      'src/core/permissions/adapters.ts:requestReminderLocation',
      'src/core/permissions/adapters.ts:requestAlwaysForReminder',
      'src/boot/device.ts:reminderOff',
    ]);
  });

  test('the plumbing names nothing that starts a drive and imports nothing of the drive but types; Home reads no link parameter', () => {
    const planted = {
      'src/features/notifications/y.ts': 'const host = useDriveHost(); host.start();',
      'src/features/notifications/z.tsx': "await DriveSense.startCapture('mounted'); const c = useContext(DriveContext);",
      'src/features/home/z.ts': 'const { start } = useLocalSearchParams();',
      // fine: the drive elsewhere, params elsewhere
      'src/features/drive/ok.ts': "await source.startCapture('mounted');",
      'app/(app)/friends/[code].tsx': 'const { code } = useLocalSearchParams();',
    };
    expect(found(planted)).toEqual([
      'src/features/notifications/y.ts:useDriveHost',
      'src/features/notifications/z.tsx:startCapture',
      'src/features/notifications/z.tsx:DriveContext',
      'src/features/home/z.ts:useLocalSearchParams',
    ]);
    expect(
      notificationImports({
        'src/features/notifications/a.ts': "import { createDriveHost } from '@/drive/host';",
        'src/features/notifications/b.ts': "import { useDrive } from '../../drive/useDrive';",
        'src/features/notifications/c.ts': "const { HudScreen } = require('@/features/drive/HudScreen');",
        'src/features/notifications/d.ts': "import { HomeScreen } from '@/features/home/HomeScreen';",
        'src/features/notifications/e.ts': "const host = await import('@/drive/host');",
        // fine: types, the start notice, packages, other features
        'src/features/notifications/ok.ts': ["import type { StartResult } from '@/drive/host';", "import { showStartNotice } from '@/features/home/startNotice';", "import DriveSense from '@drive-sense';"].join('\n'),
        'src/features/home/ok.ts': "import { useDrive } from '@/drive/useDrive';",
      })
    ).toEqual(['src/features/notifications/a.ts', 'src/features/notifications/b.ts', 'src/features/notifications/c.ts', 'src/features/notifications/d.ts', 'src/features/notifications/e.ts']);
    expect(resolveSpecifier('src/features/notifications/x.ts', '../../drive/useDrive')).toBe('src/drive/useDrive');
    expect(resolveSpecifier('src/features/notifications/x.ts', '@/features/home')).toBe('src/features/home');
    expect(resolveSpecifier('src/features/notifications/x.ts', 'expo-router')).toBeNull();
  });

  test('a background-task package is found in package.json', () => {
    expect(forbiddenPackages({ dependencies: { 'expo-task-manager': '~1.0.0', expo: '55' } })).toEqual(['expo-task-manager']);
    expect(forbiddenPackages({ devDependencies: { 'expo-background-task': '1' }, optionalDependencies: { 'expo-background-fetch': '1' } })).toEqual([
      'expo-background-fetch',
      'expo-background-task',
    ]);
    expect(forbiddenPackages({ dependencies: { 'expo-location': '1', 'expo-task-managerial': '1' } })).toEqual([]);
  });

  test('allows the owners, and ignores comments and longer identifiers', () => {
    const fine = {
      'src/core/permissions/adapters.ts': 'await deps.location.requestForegroundPermissionsAsync(); await detect.requestAlways(); await deps.location.getBackgroundPermissionsAsync();',
      'src/features/notifications/handler.ts': 'n.setNotificationHandler({});',
      'src/features/onboarding/steps/LocationStep.tsx': 'await permissions.requestLocationAlways();',
      'src/features/drive/a.ts': [
        '// Location.requestForegroundPermissionsAsync() is the adapter’s job',
        '/* setNotificationHandler lives in notifications; no TaskManager.defineTask; detect.setArmed(true) */',
        "const url = 'https://example.com/a'; // setAutoDetect",
        'const requestMotionPermissionCopy = 1;',
        'const startLocationUpdatesAsyncLater = 2;',
        'setAutoDetectRuntime(null); const notDrivingAvailable = true;',
      ].join('\n'),
    };
    expect(scan(fine)).toEqual([]);
  });

  test('stripComments keeps code and strings, drops comments', () => {
    expect(stripComments("a(); // x()\nb('//not a comment'); /* c() */ d();")).toBe(
      "a(); \nb('//not a comment');  d();"
    );
  });
});

describe('the repository', () => {
  const files = { ...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'app')) };

  test('is scanned (a sanity check that the walk found the code)', () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'src/core/permissions/adapters.ts',
        'src/features/notifications/NotificationsHost.tsx',
        'src/drive/host.ts',
        'src/boot/autoDetect.ts',
        'app/_layout.tsx',
      ])
    );
    expect(Object.keys(files).some((f) => f.includes('__tests__'))).toBe(false);
  });

  test('one permission system, one notification plumbing, one drive host, no background detection in JS', () => {
    expect(scan(files)).toEqual([]);
  });

  test('the notification plumbing imports nothing of the drive but types', () => {
    expect(notificationImports(files)).toEqual([]);
  });

  test("the forgot-to-start reminder's files are gone", () => {
    expect(Object.keys(files).filter((f) => f.startsWith('src/features/reminder/'))).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, 'src', 'features', 'notifications', 'reminderTap.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src', 'features', 'onboarding', 'steps', 'ReminderStep.tsx'))).toBe(false);
  });

  test('package.json depends on no background-task package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;
    expect(Object.keys(pkg.dependencies ?? {})).toContain('expo-location'); // the read found the real file
    expect(forbiddenPackages(pkg)).toEqual([]);
  });

  test("M3's interim detection screen, its /detection route and the auto-record route are gone", () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'features', 'drive', 'DetectionScreen.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app', '(app)', 'detection.tsx'))).toBe(false);
    expect(Object.values(files).some((src) => /['"`]\/detection['"`?]/.test(stripComments(src)))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app', '(app)', 'permissions', 'auto-record.tsx'))).toBe(false);
  });
});
