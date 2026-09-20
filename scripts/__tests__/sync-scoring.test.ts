import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = join(__dirname, '..', '..');
const functions = join(root, 'supabase', 'functions');
const src = join(root, 'packages', 'scoring', 'src');
const dst = join(functions, '_shared', 'scoring');
/** Written by the sync script, with no counterpart in the package. */
const GENERATED = new Set(['README.md', 'deno.json']);
const modules = (dir: string) =>
  readdirSync(dir)
    .filter((f) => !GENERATED.has(f) && statSync(join(dir, f)).isFile())
    .sort();
const denoConfig = () =>
  JSON.parse(readFileSync(join(functions, 'deno.json'), 'utf8')) as {
    imports?: Record<string, string>;
  };

test('the edge-function copy of the scoring package is byte-identical', () => {
  for (const f of modules(src)) expect(readFileSync(join(dst, f), 'utf8')).toBe(readFileSync(join(src, f), 'utf8'));
});

test('both directories hold the same modules, so a deleted one fails too', () => {
  expect(modules(dst)).toEqual(modules(src));
});

test('deno.json maps every copied module to its .ts file, and nothing else', () => {
  const scoring = Object.entries(denoConfig().imports ?? {}).filter(([k]) =>
    k.startsWith('./_shared/scoring/')
  );
  expect(Object.fromEntries(scoring)).toEqual(
    Object.fromEntries(
      modules(src).map((f) => [
        `./_shared/scoring/${f.replace(/\.ts$/, '')}`,
        `./_shared/scoring/${f}`,
      ])
    )
  );
});

test('the edge-function copy of the upload contract is byte-identical', () => {
  expect(readFileSync(join(functions, '_shared', 'payload.ts'), 'utf8')).toBe(
    readFileSync(join(root, 'src', 'data', 'sync', 'payload.ts'), 'utf8')
  );
});

test('deno.json pins zod to the version the app has installed', () => {
  const installed = (JSON.parse(readFileSync(join(root, 'node_modules', 'zod', 'package.json'), 'utf8')) as {
    version: string;
  }).version;
  expect(denoConfig().imports?.zod).toBe(`npm:zod@${installed}`);
});
