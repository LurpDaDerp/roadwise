/** @jest-environment node */
// One caller (plan rev1 S-M1; security T13 M-1, T14 m-1): only src/core/dms/host/** may reference the native
// wrapper (whose start/setPolicy run the camera) or `createGate` (the token mint); nothing re-exports either
// (so no host file can hand them on under another name); `as GateToken` appears only in gate.ts. M7 and the
// dev diagnostics route build their controller with `createDefaultDmsController` (host/default.ts), which
// binds the wrapper inside the host. The wire, the types, the constants and the fake may be referenced
// anywhere (they run nothing).
//
// A reference is any module specifier, single- or double-quoted: `import … from`, `export … from`, a bare
// `import '…'`, `require(…)`, `import(…)` and `jest.requireActual(…)`. The scan covers src/, app/, packages/
// and the repository root's own .ts/.tsx files. It is a tripwire, not a type system: the typed sinks
// (gatedNative, nativePolicy) are the enforcement.

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readdirSync: (d: string, o: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[]; readFileSync: (f: string, e: 'utf8') => string; existsSync: (p: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string; resolve: (...p: string[]) => string; relative: (a: string, b: string) => string };

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SELF = path.relative(ROOT, path.resolve(__dirname, 'imports.test.ts')).replace(/\\/g, '/');
const SOURCE = /\.(ts|tsx)$/;

function walk(dir: string, deep = true): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (deep) out.push(...walk(p));
    } else if (SOURCE.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'packages')), ...walk(ROOT, false)]
  .map((f) => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }))
  .filter((f) => f.rel !== SELF);

const HOST = (rel: string) => rel.startsWith('src/core/dms/host/');

/** Every module specifier in a source, whatever the form or the quotes. */
export function specifiers(src: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\brequireActual\s*(?:<[^>]*>)?\s*\(\s*)(['"])([^'"\n]+)\1/g;
  const out: string[] = [];
  for (const m of src.matchAll(re)) out.push(m[2]!);
  return out;
}
/** The wrapper itself: the package root, its src/ folder or src/index (not the wire, types, constants or fake). */
const isWrapper = (spec: string) => /(^|\/)modules\/dms-vision(\/src)?(\/index)?$/.test(spec);
const isGateModule = (spec: string) => /(^|\/)policy\/gate$/.test(spec) || spec === './gate' || spec === '../gate';

/** The local names a source binds from the wrapper (default and named imports). */
function wrapperBindings(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s+(?!type\b)([^'";]+?)\s+from\s*(['"])([^'"\n]+)\2/g)) {
    if (!isWrapper(m[3]!)) continue;
    const clause = m[1]!;
    const def = /^([A-Za-z_$][\w$]*)/.exec(clause);
    if (def && def[1] !== '*') names.push(def[1]!);
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) names.push(ns[1]!);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1]!.split(',')) {
      const bits = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (bits[0] && !part.trim().startsWith('type ')) names.push((bits[1] ?? bits[0]).trim());
    }
  }
  return names.filter((n) => n.length > 0);
}

/** A source that re-exports the wrapper's values or createGate, by any route. */
export function reExports(src: string): boolean {
  // `export … from '<wrapper>'` (values; `export type` is harmless) and `export * from '…/policy/gate'`.
  for (const m of src.matchAll(/export\s+(?!type\b)(\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*(['"])([^'"\n]+)\2/g)) {
    if (isWrapper(m[3]!)) return true;
    if (isGateModule(m[3]!) && (m[1] === '*' || /\bcreateGate\b/.test(m[1]!))) return true;
  }
  // `export { createGate }`, `export { createGate as mint }`, `export const mint = createGate`.
  if (/export\s*\{[^}]*\bcreateGate\b[^}]*\}/.test(src) || /export\s+(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*createGate\b/.test(src)) return true;
  // A binding imported from the wrapper, exported again.
  for (const n of wrapperBindings(src)) {
    const e = n.replace(/\$/g, '\\$');
    if (new RegExp(`export\\s*\\{[^}]*\\b${e}\\b[^}]*\\}`).test(src)) return true;
    if (new RegExp(`export\\s+(?:const|let|var)\\s+[\\w$]+\\s*(?::[^=]+)?=\\s*${e}\\b`).test(src)) return true;
    if (new RegExp(`export\\s+default\\s+${e}\\b`).test(src)) return true;
  }
  return false;
}

test('the scan sees the host, the app routes, packages/ and the root files', () => {
  expect(files.some((f) => f.rel === 'src/core/dms/host/controller.ts')).toBe(true);
  expect(files.some((f) => f.rel.startsWith('app/'))).toBe(true);
  expect(files.some((f) => f.rel.startsWith('packages/'))).toBe(true);
  expect(files.some((f) => f.rel === 'index.ts')).toBe(true);
});

test('only the host references the native wrapper (start/setPolicy), in any form', () => {
  const offenders = files.filter((f) => !HOST(f.rel) && specifiers(f.src).some(isWrapper)).map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test('only the host references createGate (the token mint); the policy’s own files aside', () => {
  const offenders = files
    .filter((f) => /\bcreateGate\b/.test(f.src) && specifiers(f.src).some(isGateModule))
    .filter((f) => !HOST(f.rel) && !f.rel.startsWith('src/core/dms/policy/'))
    .map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test('nothing re-exports the wrapper or createGate (so neither leaves the host under another name)', () => {
  const offenders = files.filter((f) => f.rel !== 'src/core/dms/policy/gate.ts' && reExports(f.src)).map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test('`as GateToken` appears only in gate.ts', () => {
  const offenders = files.filter((f) => /as\s+(unknown\s+as\s+)?GateToken\b/.test(f.src) && f.rel !== 'src/core/dms/policy/gate.ts').map((f) => f.rel);
  expect(offenders).toEqual([]);
});

describe('the scan bites', () => {
  const W = '../../../modules/dms-vision';
  test.each([
    [`import DmsVision from '${W}';`],
    [`import DmsVision from "${W}";`],
    [`const D = require('${W}');`],
    [`const D = require("${W}/src/index");`],
    [`const D = await import('${W}/src');`],
    [`const D = jest.requireActual<typeof x>("${W}");`],
    [`import '${W}';`],
    [`export { default as Native } from '${W}';`],
  ])('a wrapper reference: %s', (line) => {
    expect(specifiers(line).some(isWrapper)).toBe(true);
  });
  test('the wire, types, constants and fake are not the wrapper', () => {
    for (const leaf of ['wire', 'types', 'constants', 'fake']) expect(specifiers(`import { x } from '${W}/src/${leaf}';`).some(isWrapper)).toBe(false);
  });
  test.each([
    [`export { createGate as mint } from '../policy/gate';`],
    [`export * from "../policy/gate";`],
    [`import { createGate } from '../policy/gate';\nexport { createGate };`],
    [`import { createGate as g } from '../policy/gate';\nexport const mint = g;\nexport const also = createGate;`],
    [`export { default } from '${W}';`],
    [`import DmsVision from '${W}';\nexport { DmsVision as native };`],
    [`import DmsVision from '${W}';\nexport const native = DmsVision;`],
    [`import DmsVision from '${W}';\nexport default DmsVision;`],
    [`import { DmsVision as N } from "${W}";\nexport { N };`],
  ])('a re-export: %s', (src) => {
    expect(reExports(src)).toBe(true);
  });
  test('using the wrapper, or re-exporting only its types, is not a re-export', () => {
    expect(reExports(`import DmsVision from '${W}';\nexport function make() { return create({ native: DmsVision }); }`)).toBe(false);
    expect(reExports(`export type { DmsVisionApi } from '${W}/src/types';`)).toBe(false);
  });
  test('as GateToken', () => {
    expect(/as\s+(unknown\s+as\s+)?GateToken\b/.test('const t = s as GateToken;')).toBe(true);
  });
});
