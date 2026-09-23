/**
 * Regenerates the golden vectors in modules/dms-vision/assets/vectors.
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON modules/dms-vision/scripts/make-vectors.ts
 *
 * Every vector is what `vectorBuilders.ts` returns (the TS reference over synthetic inputs).
 * `onnx-parity.json` is special: this script writes its INPUTS, and keeps the committed expected
 * outputs only while the inputs are unchanged. When they change it empties them and asks for
 * `make-onnx-vectors.py`, which fills them from Python onnxruntime 1.30.0.
 *
 * The module's sources use extension-less relative imports; a resolve hook retries them with `.ts`
 * (the drive-sense pattern). This file has no import/export statements, so Node runs it as CommonJS.
 */

declare const __dirname: string;
declare const process: { cwd(): string };

type ResolveResult = { url: string };
type NextResolve = (specifier: string, context: unknown) => ResolveResult;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS script; see the header
const nodeModule = require('node:module') as {
  registerHooks(hooks: { resolve(specifier: string, context: unknown, next: NextResolve): ResolveResult }): unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const fs = require('node:fs') as {
  mkdirSync(dir: string, opts: { recursive: true }): void;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  readFileSync(file: string, encoding: 'utf8'): string;
  existsSync(file: string): boolean;
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
const builders = require('./vectorBuilders.ts') as {
  VECTOR_NAMES: readonly string[];
  buildVectors(v1: unknown): Record<string, unknown>;
  onnxInputs(): unknown[];
  serializeVector(v: unknown): string;
};

const DIR = path.resolve(__dirname, '..', 'assets', 'vectors');
const V1 = path.resolve(__dirname, '..', '__tests__', 'fixtures', 'v1-reference', 'gaze_inputs_stats_tracker.json');
fs.mkdirSync(DIR, { recursive: true });

const vectors = builders.buildVectors(JSON.parse(fs.readFileSync(V1, 'utf8')));
let bytes = 0;
for (const [name, v] of Object.entries(vectors)) {
  const text = builders.serializeVector(v);
  bytes += text.length;
  fs.writeFileSync(path.join(DIR, `${name}.json`), text, 'utf8');
}

// onnx-parity: keep the Python outputs only while the inputs are identical.
const onnxFile = path.join(DIR, 'onnx-parity.json');
const inputs = { cases: builders.onnxInputs() };
let expected: { cases: unknown[] } = { cases: [] };
if (fs.existsSync(onnxFile)) {
  const old = JSON.parse(fs.readFileSync(onnxFile, 'utf8')) as { inputs: unknown; expected: { cases: unknown[] } };
  if (JSON.stringify(old.inputs) === JSON.stringify(inputs)) expected = old.expected;
}
const onnx = {
  name: 'onnx-parity',
  description: 'gaze_direct on 8 synthetic input sets; expected outputs from Python onnxruntime 1.30.0 (CPU)',
  kind: 'onnx',
  inputs,
  expected,
};
const onnxText = builders.serializeVector(onnx);
bytes += onnxText.length;
fs.writeFileSync(onnxFile, onnxText, 'utf8');

const stale = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !builders.VECTOR_NAMES.includes(f.slice(0, -5)));
for (const f of stale) fs.rmSync(path.join(DIR, f));

console.log(`wrote ${builders.VECTOR_NAMES.length} vectors (${Math.round(bytes / 1024)} KB) to ${path.relative(process.cwd(), DIR)}`);
if (expected.cases.length === 0) {
  console.log('onnx-parity: inputs changed; run scripts/make-onnx-vectors.py to fill its expected outputs');
}
