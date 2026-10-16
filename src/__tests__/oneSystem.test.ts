/**
 * Mechanical proof of "one permission system, one notification plumbing, and every drive started
 * by hand: the Start Drive tap, or a tap on the forgot-to-start reminder's notification, which the
 * notification-tap handler claims natively and then starts through the same Start Drive path;
 * nothing automatic" (Task 19; rev1: C1, I3; plan §1 decision 4). Every source file under `src/`
 * and `app/` (tests and fixtures excluded) is read with its comments stripped, and:
 *
 * - no file outside `src/core/permissions` names `requestForegroundPermissionsAsync`,
 *   `requestPermissionsAsync`, `requestMotionPermission` or `requestReminderLocation`;
 * - no file at all names anything that detects a trip or starts a drive on its own in JS:
 *   background location (`requestLocationAlways`, `requestBackgroundPermissionsAsync`,
 *   `startLocationUpdatesAsync`), geofences and significant-location changes, background tasks
 *   (`TaskManager`, `defineTask`, `registerTaskAsync`, `BackgroundFetch`), the old auto-record switch
 *   (`setAutoDetect`) or the old forgot-to-start reminder (`setForgotToStartReminder`,
 *   `checkForgottenDrive`); and `package.json` carries no background-task package. The optional
 *   forgot-to-start reminder lives in native code (drive-sense) and only notifies; JS switches it
 *   and reads its status from `src/features/reminder` alone;
 * - the reminder's own files can reach nothing that starts a drive; only the notification-tap
 *   handler (`src/features/notifications/reminderTap.ts`) claims a reminder tap, only the
 *   notification plumbing runs one, and that plumbing names nothing that starts a drive and imports
 *   nothing of the drive but its types (it is handed the start); the start notice Home shows
 *   carries words only; Home reads no link parameter (a notification or link opens Home and starts
 *   nothing); and no JS sets notification categories (no RoadWise notification has buttons);
 * - only `src/features/notifications` names `setNotificationHandler` or
 *   `addNotificationResponseReceivedListener`;
 * - M3's interim detection screen, its `/detection` route and the auto-record route are gone.
 *
 * A name is matched as a whole identifier anywhere in code (a call, a reference or a destructure),
 * so passing `Location.requestForegroundPermissionsAsync` along uncalled is caught too. The scanner
 * is checked against planted sources first (the negative control).
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
  names: readonly string[];
  /** Repo-relative, forward-slash path prefixes where the names are allowed. */
  allowed: readonly string[];
  /** When set, the rule applies only to files under these prefixes (else everywhere). */
  scope?: readonly string[];
}

/** Names of automatic or background drive and trip detection; allowed nowhere. */
export const FORBIDDEN_DETECTION: readonly string[] = [
  'setAutoDetect',
  'requestLocationAlways',
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

/** The forgot-to-start reminder's own JS files. */
export const REMINDER_FILES: readonly string[] = ['src/features/reminder/', 'src/features/onboarding/steps/ReminderStep.tsx'];

/** What could start a drive from JS (the drive host and every way to reach it); none of it may appear in the reminder's files. */
export const REMINDER_NEVER_STARTS: readonly string[] = [
  'startCapture',
  'useStartDrive',
  'useDriveControls',
  'nativeDriveSource',
  'StartDriveBar',
  'useDriveHost',
  'DriveContext',
  'DriveProvider',
  'createDriveHost',
];

/** Repo paths the reminder's files may not import, by any route: the drive, the drive screens, Home. */
export const REMINDER_FORBIDDEN_MODULES: readonly string[] = ['src/drive', 'src/features/drive', 'src/features/home'];

/** The notification plumbing, which runs a reminder tap with the start it is handed. */
export const NOTIFICATION_FILES: readonly string[] = ['src/features/notifications/'];

/** The one Home module the notification plumbing may import a value from: the start notice (words only). */
export const NOTIFICATION_ALLOWED_MODULES: readonly string[] = ['src/features/home/startNotice'];

/** The start notice Home shows when a reminder tap started no drive. */
export const START_NOTICE_FILE = 'src/features/home/startNotice.ts';

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
    names: ['requestForegroundPermissionsAsync', 'requestPermissionsAsync', 'requestMotionPermission', 'requestReminderLocation'],
    allowed: ['src/core/permissions/'],
  },
  {
    // The optional forgot-to-start reminder is switched from Settings and onboarding, and off at
    // sign-out and the device wipe, all through `src/features/reminder`.
    name: 'only the reminder feature switches the forgot-to-start reminder',
    names: ['setTripReminder', 'getTripReminderStatus'],
    allowed: ['src/features/reminder/'],
  },
  {
    name: 'the forgot-to-start reminder never starts a drive',
    names: REMINDER_NEVER_STARTS,
    allowed: [],
    scope: REMINDER_FILES,
  },
  {
    // A tap's token is claimed natively once, by the handler that then starts the drive.
    name: 'only the notification-tap handler claims a reminder tap',
    names: ['claimReminderTap', 'takeReminderTap'],
    allowed: ['src/features/notifications/reminderTap.ts'],
  },
  {
    name: 'a reminder tap starts a drive only through NotificationsHost',
    names: ['startFromReminderTap', 'watchReminderTapIntents'],
    allowed: NOTIFICATION_FILES,
  },
  {
    // It is handed the Start Drive button's start (`startDrive`); it names no way to the drive itself.
    name: 'the notification plumbing cannot reach the drive by itself',
    names: REMINDER_NEVER_STARTS,
    allowed: [],
    scope: NOTIFICATION_FILES,
  },
  {
    name: 'the start notice carries words only',
    names: [...REMINDER_NEVER_STARTS, 'start', 'claimReminderTap'],
    allowed: [],
    scope: [START_NOTICE_FILE],
  },
  {
    // A notification tap or a link opens Home; Home starts nothing from what opened it.
    name: 'Home never reads a link parameter',
    names: ['useLocalSearchParams', 'useGlobalSearchParams', 'useSearchParams'],
    allowed: [],
    scope: ['app/(tabs)/home.tsx', 'src/features/home/'],
  },
  {
    // No RoadWise notification has buttons: the forgot-to-start reminder's only action is its tap
    // (PRODUCT.md). A category set from JS would add buttons nothing handles.
    name: 'no JS notification categories',
    names: ['setNotificationCategoryAsync'],
    allowed: [],
  },
  {
    // plan §1 decision 4: a drive exists only after the driver taps Start Drive. Nothing watches
    // for a trip in the background, and nothing starts or proposes a drive on its own. Crash
    // recovery (`adopt`) and the Android sticky restart only continue a drive the driver started.
    name: 'no automatic or background drive detection: a drive starts only from the Start Drive tap',
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
      for (const name of rule.names) {
        if (new RegExp(`(^|[^A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`).test(code)) {
          found.push({ rule: rule.name, file, name });
        }
      }
    }
  }
  return found;
}

/** Whether `target` is `mod` or under it. */
const within = (target: string, mod: string): boolean => target === mod || target.startsWith(`${mod}/`);

/** The reminder files that import (statically, dynamically or by `require`, by alias or relative path) the drive, the drive screens or Home. */
export function reminderImports(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([file, src]) => {
      if (!REMINDER_FILES.some((p) => file.startsWith(p))) return false;
      return [...stripComments(src).matchAll(SPECIFIER)].some((m) => {
        const target = resolveSpecifier(file, m[2] as string);
        return target !== null && REMINDER_FORBIDDEN_MODULES.some((mod) => within(target, mod));
      });
    })
    .map(([file]) => file);
}

/** `import type …` and `export type … from` statements: erased at build, so they reach nothing at run time. */
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*(['"`])[^'"`]+\1/g;

/**
 * The notification files, and the start notice, that import a value (types are fine: they are
 * erased) from the drive, the drive screens or Home (the start notice excepted, for the plumbing).
 */
export function notificationImports(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([file, src]) => {
      const plumbing = NOTIFICATION_FILES.some((p) => file.startsWith(p));
      if (!plumbing && file !== START_NOTICE_FILE) return false;
      const code = stripComments(src).replace(TYPE_ONLY, '');
      return [...code.matchAll(SPECIFIER)].some((m) => {
        const target = resolveSpecifier(file, m[2] as string);
        if (target === null) return false;
        if (plumbing && NOTIFICATION_ALLOWED_MODULES.some((mod) => within(target, mod))) return false;
        const forbidden = plumbing ? REMINDER_FORBIDDEN_MODULES : ['src/drive', 'src/features/drive'];
        return forbidden.some((mod) => within(target, mod));
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

describe('the scanner (negative control)', () => {
  test('finds a planted call, a reference passed along uncalled, a destructure and a computed call', () => {
    const planted = {
      'src/features/drive/x.ts': 'await Location.requestForegroundPermissionsAsync();',
      'src/features/drive/y.ts': 'const deps = { request: Location.requestBackgroundPermissionsAsync };',
      'app/z.tsx': "const { requestMotionPermission } = DriveSense; Notifications.requestPermissionsAsync({});",
      'src/features/home/w.ts': 'Notifications.setNotificationHandler(null); N.addNotificationResponseReceivedListener(f);',
      'src/features/onboarding/v.ts': 'await adapter.requestLocationAlways({ firstDriveDone: true });',
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
    expect(scan(planted).map((v) => `${v.file}:${v.name}`)).toEqual([
      'src/features/drive/x.ts:requestForegroundPermissionsAsync',
      'src/features/drive/y.ts:requestBackgroundPermissionsAsync',
      'app/z.tsx:requestPermissionsAsync',
      'app/z.tsx:requestMotionPermission',
      'src/features/home/w.ts:setNotificationHandler',
      'src/features/home/w.ts:addNotificationResponseReceivedListener',
      'src/features/onboarding/v.ts:requestLocationAlways',
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

  test('the reminder rules: no start in its files, no switch outside them, no Always request outside the adapter, no link parameter on Home', () => {
    const planted = {
      'src/features/reminder/x.ts': "import { startCapture } from '@drive-sense'; await DriveSense.startCapture('mounted');",
      'src/drive/host.ts': 'await DriveSense.setTripReminder(true);',
      'src/features/settings/y.ts': 'await port.requestReminderLocation();',
      'src/features/home/z.ts': 'const { start } = useLocalSearchParams();',
      // Outside the reminder's files the drive is started as before; elsewhere the params are fine.
      'src/features/drive/ok.ts': "await source.startCapture('mounted');",
      'app/(app)/clan/[code].tsx': 'const { code } = useLocalSearchParams();',
      'src/features/reminder/ok.ts': 'await native.setTripReminder(true);',
    };
    expect(scan(planted).map((v) => `${v.file}:${v.name}`)).toEqual([
      'src/features/reminder/x.ts:startCapture',
      'src/drive/host.ts:setTripReminder',
      'src/features/settings/y.ts:requestReminderLocation',
      'src/features/home/z.ts:useLocalSearchParams',
    ]);
    expect(
      reminderImports({
        'src/features/reminder/a.ts': "import { useDrive } from '@/drive/useDrive';",
        'src/features/onboarding/steps/ReminderStep.tsx': "import { StartDrive } from '@/features/home';",
        'src/features/reminder/b.ts': "import { x } from '@/features/drives';",
        'src/features/settings/c.ts': "import { useDrive } from '@/drive/useDrive';",
        // every other route to the drive: a relative path, require, a dynamic import, a re-export, a bare import
        'src/features/reminder/rel.ts': "import { useDriveHost } from '../../drive/useDrive';",
        'src/features/reminder/req.ts': "const { useDriveHost } = require('@/drive/useDrive');",
        'src/features/reminder/dyn.ts': "const host = await import('@/drive/host');",
        'src/features/reminder/re.ts': "export { DriveScreen } from '../drive/DriveScreen';",
        'src/features/reminder/side.ts': "import '../home';",
        // fine: the reminder's own files, other features, packages
        'src/features/reminder/ok.ts': "import { reminderCopy } from './copy'; import x from '../permissions/usePermissionHealth'; import DriveSense from '@drive-sense';",
      })
    ).toEqual([
      'src/features/reminder/a.ts',
      'src/features/onboarding/steps/ReminderStep.tsx',
      'src/features/reminder/rel.ts',
      'src/features/reminder/req.ts',
      'src/features/reminder/dyn.ts',
      'src/features/reminder/re.ts',
      'src/features/reminder/side.ts',
    ]);
    expect(resolveSpecifier('src/features/reminder/enable.ts', '../../drive/useDrive')).toBe('src/drive/useDrive');
    expect(resolveSpecifier('src/features/reminder/enable.ts', '@/features/home')).toBe('src/features/home');
    expect(resolveSpecifier('src/features/reminder/enable.ts', 'expo-router')).toBeNull();
  });

  test('the reminder files may not name the drive host or any way to reach it', () => {
    const planted = {
      'src/features/reminder/h.ts': 'useDriveHost().start();',
      'src/features/reminder/c.tsx': 'const host = useContext(DriveContext);',
      'src/features/onboarding/steps/ReminderStep.tsx': '<DriveProvider host={createDriveHost(deps)} />',
    };
    expect(scan(planted).map((v) => `${v.file}:${v.name}`)).toEqual([
      'src/features/reminder/h.ts:useDriveHost',
      'src/features/reminder/c.tsx:DriveContext',
      'src/features/onboarding/steps/ReminderStep.tsx:DriveProvider',
      'src/features/onboarding/steps/ReminderStep.tsx:createDriveHost',
    ]);
  });

  test('the reminder tap rules: a claim only in the tap handler, a run only in the plumbing, nothing of the drive in the plumbing or the notice', () => {
    const planted = {
      'src/features/home/x.ts': "await DriveSense.claimReminderTap('tok');",
      'src/features/reminder/t.ts': 'const tap = await DriveSense.takeReminderTap();',
      'app/_layout.tsx': 'void startFromReminderTap(hold, deps); watchReminderTapIntents(f);',
      'src/features/notifications/y.ts': 'const host = useDriveHost(); host.start();',
      'src/features/notifications/z.tsx': '<StartDriveBar onStart={f} />',
      'src/features/home/startNotice.ts': "await DriveSense.startCapture('mounted'); start();",
      // fine: the tap handler claims, the plumbing runs it, the layout hands it the start
      'src/features/notifications/reminderTap.ts': 'await native.claimReminderTap(token); await native.takeReminderTap();',
      'src/features/notifications/NotificationsHost.tsx': 'startFromReminderTap(hold, { start: () => props.startDrive() }); watchReminderTapIntents(f);',
      'app/(tabs)/ok.tsx': 'startDrive={() => host.start()}',
    };
    expect(scan(planted).map((v) => `${v.file}:${v.name}`)).toEqual([
      'src/features/home/x.ts:claimReminderTap',
      'src/features/reminder/t.ts:takeReminderTap',
      'app/_layout.tsx:startFromReminderTap',
      'app/_layout.tsx:watchReminderTapIntents',
      'src/features/notifications/y.ts:useDriveHost',
      'src/features/notifications/z.tsx:StartDriveBar',
      'src/features/home/startNotice.ts:startCapture',
      'src/features/home/startNotice.ts:start',
    ]);
    expect(
      notificationImports({
        'src/features/notifications/a.ts': "import { createDriveHost } from '@/drive/host';",
        'src/features/notifications/b.ts': "import { useDrive } from '../../drive/useDrive';",
        'src/features/notifications/c.ts': "const { HudScreen } = require('@/features/drive/HudScreen');",
        'src/features/notifications/d.ts': "import { HomeScreen } from '@/features/home/HomeScreen';",
        'src/features/home/startNotice.ts': "import { useDrive } from '@/drive/useDrive';",
        // fine: types, the start notice, packages
        'src/features/notifications/ok.ts': ["import type { StartResult } from '@/drive/host';", "import { showStartNotice } from '@/features/home/startNotice';", "import DriveSense from '@drive-sense';"].join('\n'),
        'src/features/home/ok.ts': "import { useDrive } from '@/drive/useDrive';",
      })
    ).toEqual([
      'src/features/notifications/a.ts',
      'src/features/notifications/b.ts',
      'src/features/notifications/c.ts',
      'src/features/notifications/d.ts',
      'src/features/home/startNotice.ts',
    ]);
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
      'src/core/permissions/adapters.ts': 'await deps.location.requestForegroundPermissionsAsync(); await deps.location.getBackgroundPermissionsAsync();',
      'src/features/notifications/handler.ts': 'n.setNotificationHandler({});',
      'src/features/drive/a.ts': [
        '// Location.requestForegroundPermissionsAsync() is the adapter’s job',
        '/* setNotificationHandler lives in notifications; no TaskManager.defineTask */',
        "const url = 'https://example.com/a'; // setAutoDetect",
        'const requestMotionPermissionCopy = 1;',
        'const startLocationUpdatesAsyncLater = 2;',
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
        'src/features/drive/summaryNotifier.ts',
        'app/_layout.tsx',
      ])
    );
    expect(Object.keys(files).some((f) => f.includes('__tests__'))).toBe(false);
  });

  test('one permission system, one notification plumbing, no automatic drive detection', () => {
    expect(scan(files)).toEqual([]);
  });

  test("the forgot-to-start reminder's files exist, are scanned, and import nothing that starts a drive", () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['src/features/reminder/enable.ts', 'src/features/reminder/ReminderRow.tsx', 'src/features/onboarding/steps/ReminderStep.tsx'])
    );
    expect(reminderImports(files)).toEqual([]);
  });

  test('a reminder tap reaches the drive only as the start it is handed: the plumbing and the start notice import nothing of the drive but types', () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([START_NOTICE_FILE, 'src/features/notifications/reminderTap.ts', 'src/features/notifications/NotificationsHost.tsx'])
    );
    expect(notificationImports(files)).toEqual([]);
    // the root layout hands the host's own start to the plumbing
    expect(stripComments(files['app/_layout.tsx'] ?? '')).toContain('const startDrive = useCallback(() => host.start(), [host]);');
  });

  test('package.json depends on no background-task package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;
    expect(Object.keys(pkg.dependencies ?? {})).toContain('expo-location'); // the read found the real file
    expect(forbiddenPackages(pkg)).toEqual([]);
  });

  test("M3's interim detection screen and its /detection route are gone", () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'features', 'drive', 'DetectionScreen.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app', '(app)', 'detection.tsx'))).toBe(false);
    expect(Object.values(files).some((src) => /['"`]\/detection['"`?]/.test(stripComments(src)))).toBe(false);
    // v3: the auto-record route is gone too.
    expect(fs.existsSync(path.join(ROOT, 'app', '(app)', 'permissions', 'auto-record.tsx'))).toBe(false);
  });
});
