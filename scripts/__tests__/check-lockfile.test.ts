import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS maintenance script
const { lockProblems } = require('../check-lockfile.js') as {
  lockProblems: (pkg: Pkg, lock: Lock) => string[];
};

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; overrides?: Record<string, unknown> };
type Lock = { packages: Record<string, { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };

const root = join(__dirname, '..', '..');
const pkg = (): Pkg => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = (): Lock => JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

test('package-lock.json passes the check EAS Build runs before `npm ci` installs anything', () => {
  expect(lockProblems(pkg(), lock())).toEqual([]);
});

test('a hoisted package locked below a range its dependents ask for fails (the npm 11 drift EAS refuses)', () => {
  const l = lock();
  const key = 'node_modules/@expo/require-utils';
  expect(l.packages[key]).toBeDefined();
  l.packages[key] = { ...l.packages[key], version: '57.0.0' };
  expect(lockProblems(pkg(), l).some((p) => p.includes('@expo/require-utils') && p.includes('57.0.0'))).toBe(true);
});

test('a dependency in package.json but not in the lock fails', () => {
  const p = pkg();
  p.devDependencies = { ...p.devDependencies, 'left-pad-not-installed': '^1.0.0' };
  expect(lockProblems(p, lock())).toContain('(root): left-pad-not-installed@^1.0.0 is missing from the lock');
});

test("an override holds only the edges inside its package's own folder", () => {
  const p: Pkg = { overrides: { a: { c: '^2.0.0' } } };
  const l: Lock = {
    packages: {
      '': { dependencies: { a: '^1.0.0', b: '^1.0.0', c: '^2.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { c: '^1.0.0' } },
      'node_modules/b': { version: '1.0.0', dependencies: { c: '^2.1.0' } },
      'node_modules/c': { version: '2.0.0' },
    },
  };
  // a's ^1.0.0 is overridden to ^2.0.0 (held); b's ^2.1.0 is not, and 2.0.0 does not satisfy it.
  expect(lockProblems({ ...p, dependencies: { a: '^1.0.0', b: '^1.0.0', c: '^2.0.0' } }, l)).toEqual([
    'node_modules/b: c@^2.1.0 is locked at node_modules/c@2.0.0',
  ]);
});
