/**
 * Regenerates the golden vectors in modules/drive-sense/assets/vectors.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning modules/drive-sense/scripts/make-vectors.ts
 *
 * The vectors are built by `scenarios.ts`, which simulates each drive and runs the TypeScript
 * reference over it; this script only writes down what the builders return, so
 * `__tests__/vectors.test.ts` can assert the committed JSON is byte-for-byte a fresh generation.
 *
 * Node's type stripping needs explicit `.ts` extensions, but the module's sources use
 * extension-less relative imports (what tsc, Metro and Jest expect). A synchronous resolve hook
 * (`module.registerHooks`, Node ≥ 22.15) retries a failed relative specifier with `.ts`.
 *
 * This file deliberately has no `import`/`export` statements, so Node runs it as CommonJS
 * (`require`, `__dirname`), and it reaches Node's APIs through `require` with local shapes — the
 * root tsconfig does not load @types/node for the app.
 */

declare const __dirname: string;
declare const process: { cwd(): string; exitCode?: number };

type ResolveResult = { url: string };
type NextResolve = (specifier: string, context: unknown) => ResolveResult;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS script; see the header
const nodeModule = require('node:module') as {
  registerHooks(hooks: {
    resolve(specifier: string, context: unknown, next: NextResolve): ResolveResult;
  }): unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const fs = require('node:fs') as {
  mkdirSync(dir: string, opts: { recursive: true }): void;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  readdirSync(dir: string): string[];
  rmSync(file: string): void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as {
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};

nodeModule.registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the hook is in place
const scenarios = require('./scenarios.ts') as {
  VECTOR_NAMES: string[];
  VECTOR_BUILDERS: Record<string, () => unknown>;
  serializeVector(v: unknown): string;
};

const DIR = path.resolve(__dirname, '..', 'assets', 'vectors');
fs.mkdirSync(DIR, { recursive: true });

const names = scenarios.VECTOR_NAMES;
let bytes = 0;
for (const name of names) {
  const build = scenarios.VECTOR_BUILDERS[name];
  if (!build) throw new Error(`no builder for ${name}`);
  const text = scenarios.serializeVector(build());
  bytes += text.length;
  fs.writeFileSync(path.join(DIR, `${name}.json`), text, 'utf8');
}

// A renamed or deleted builder must not leave its old vector behind for the self-test to keep
// running against: only `.json` files are ours to delete.
const stale = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !names.includes(f.slice(0, -'.json'.length)));
for (const f of stale) fs.rmSync(path.join(DIR, f));

console.log(
  `wrote ${names.length} vectors (${Math.round(bytes / 1024)} KB) to ${path.relative(process.cwd(), DIR)}`
);
if (stale.length > 0) console.log(`removed ${stale.join(', ')}`);
