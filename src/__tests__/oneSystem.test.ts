/**
 * Mechanical proof of "one permission system, one notification plumbing, and every drive started
 * by hand" (Task 19; rev1: C1, I3; plan §1 decision 4). Every source file under `src/` and `app/`
 * (tests and fixtures excluded) is read with its comments stripped, and:
 *
 * - no file outside `src/core/permissions` names `requestForegroundPermissionsAsync`,
 *   `requestPermissionsAsync` or `requestMotionPermission`;
 * - no file at all names anything that detects or starts a drive on its own: background location
 *   (`requestLocationAlways`, `requestBackgroundPermissionsAsync`, `startLocationUpdatesAsync`),
 *   geofences and significant-location changes, background tasks (`TaskManager`, `defineTask`,
 *   `registerTaskAsync`, `BackgroundFetch`), the old auto-record switch (`setAutoDetect`) or the
 *   old forgot-to-start reminder (`setForgotToStartReminder`, `checkForgottenDrive`); and
 *   `package.json` carries no background-task package;
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

/** Packages that run JS in the background with no drive open; none may be a dependency. */
export const FORBIDDEN_PACKAGES: readonly string[] = ['expo-task-manager', 'expo-background-fetch', 'expo-background-task'];

export const RULES: readonly Rule[] = [
  {
    name: 'OS permission requests only in the permission adapter (rev1: I3)',
    names: ['requestForegroundPermissionsAsync', 'requestPermissionsAsync', 'requestMotionPermission'],
    allowed: ['src/core/permissions/'],
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
