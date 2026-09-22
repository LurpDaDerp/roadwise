/**
 * Mechanical proof of "one permission system, one disclosure, one notification plumbing" (Task 19;
 * rev1: C1, I3). Every source file under `src/` and `app/` (tests and fixtures excluded) is read
 * with its comments stripped, and:
 *
 * - no file outside `src/core/permissions` names `requestForegroundPermissionsAsync`,
 *   `requestBackgroundPermissionsAsync`, `requestPermissionsAsync` or `requestMotionPermission`;
 * - only `BackgroundDisclosure` (and its definition in `src/core/permissions`) names
 *   `requestLocationAlways` — the only background-location request site (T9 security);
 * - only `src/features/notifications` names `setNotificationHandler` or
 *   `addNotificationResponseReceivedListener`;
 * - only the host, bootstrap, the shared auto-record model and the disclosure name `setAutoDetect`
 *   (Task 19 r1: every other screen turns auto-record on through the gated model);
 * - M3's interim detection screen and its `/detection` route are gone.
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

export const RULES: readonly Rule[] = [
  {
    name: 'OS permission requests only in the permission adapter (rev1: I3)',
    names: [
      'requestForegroundPermissionsAsync',
      'requestBackgroundPermissionsAsync',
      'requestPermissionsAsync',
      'requestMotionPermission',
    ],
    allowed: ['src/core/permissions/'],
  },
  {
    name: 'background location is asked for only through the one disclosure (T9 security)',
    names: ['requestLocationAlways'],
    allowed: ['src/core/permissions/', 'src/features/permissions/BackgroundDisclosure.tsx'],
  },
  {
    // Task 19 r1 (security I-1): auto-record is turned on only by the host itself, the shared
    // auto-record model (gated behind this account's disclosure) and the disclosure's Continue.
    // Bootstrap re-applies the stored choice when the server flag changes.
    name: 'auto-record is turned on only through the gated model or the disclosure',
    names: ['setAutoDetect'],
    allowed: [
      'src/drive/',
      'src/boot/bootstrap.ts',
      'src/features/onboarding/AutoRecordPanel.tsx',
      'src/features/permissions/BackgroundDisclosure.tsx',
    ],
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
    ]);
  });

  test('allows the owners, and ignores comments and longer identifiers', () => {
    const fine = {
      'src/core/permissions/adapters.ts': 'await deps.location.requestBackgroundPermissionsAsync();',
      'src/features/permissions/BackgroundDisclosure.tsx': 'await adapter.requestLocationAlways({ firstDriveDone });',
      'src/features/notifications/handler.ts': 'n.setNotificationHandler({});',
      'src/features/drive/a.ts': [
        '// Location.requestForegroundPermissionsAsync() is the adapter’s job',
        '/* setNotificationHandler lives in notifications */',
        "const url = 'https://example.com/a'; // setNotificationHandler",
        'const requestMotionPermissionCopy = 1;',
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

  test('one permission system, one disclosure, one notification plumbing', () => {
    expect(scan(files)).toEqual([]);
  });

  test("M3's interim detection screen and its /detection route are gone", () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'features', 'drive', 'DetectionScreen.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app', '(app)', 'detection.tsx'))).toBe(false);
    expect(Object.values(files).some((src) => /['"`]\/detection['"`?]/.test(stripComments(src)))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app', '(app)', 'permissions', 'auto-record.tsx'))).toBe(true);
  });
});
