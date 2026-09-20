#!/usr/bin/env node
'use strict';
/**
 * Regenerates the synthetic replay traces in src/core/__fixtures__/traces.
 *
 *   npm run traces:make
 *
 * The traces are built by src/core/replay/synth.ts; this script only writes down what its builders
 * return. That is what lets src/core/replay/__tests__/traces.test.ts assert the committed JSON is
 * byte-for-byte a fresh generation — the fixtures can never drift from the code that claims to
 * produce them.
 *
 * Node reads that TypeScript module directly (`--experimental-strip-types`, in the npm script), so
 * `synth.ts` deliberately imports nothing at run time: a `@scoring` or `@/` specifier would not
 * resolve outside Metro and Jest.
 */

const fs = require('fs');
const path = require('path');

const { TRACE_BUILDERS, serializeTrace } = require('../src/core/replay/synth.ts');

const DIR = path.resolve(__dirname, '..', 'src', 'core', '__fixtures__', 'traces');
fs.mkdirSync(DIR, { recursive: true });

const names = Object.keys(TRACE_BUILDERS).sort();
for (const name of names) {
  fs.writeFileSync(path.join(DIR, `${name}.json`), serializeTrace(TRACE_BUILDERS[name]()), 'utf8');
}

// A renamed or deleted builder must not leave its old fixture behind for the harness to keep
// replaying: nothing would regenerate it, so nothing would ever fail when it went stale. Only
// `.json` files are ours to delete — anything else in the directory belongs to someone else.
const stale = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !names.includes(f.slice(0, -'.json'.length)));
for (const name of stale) fs.rmSync(path.join(DIR, name));

console.log(`wrote ${names.length} traces to ${path.relative(process.cwd(), DIR)}`);
if (stale.length > 0) console.log(`removed ${stale.join(', ')}`);
