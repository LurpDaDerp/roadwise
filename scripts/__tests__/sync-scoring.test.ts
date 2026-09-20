import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const functions = join(__dirname, '..', '..', 'supabase', 'functions');
const src = join(__dirname, '..', '..', 'packages', 'scoring', 'src');
const dst = join(functions, '_shared', 'scoring');
/** Written by the sync script, with no counterpart in the package. */
const GENERATED = new Set(['README.md', 'deno.json']);
const modules = (dir: string) =>
  readdirSync(dir)
    .filter((f) => !GENERATED.has(f) && statSync(join(dir, f)).isFile())
    .sort();

test('the edge-function copy of the scoring package is byte-identical', () => {
  for (const f of modules(src)) expect(readFileSync(join(dst, f), 'utf8')).toBe(readFileSync(join(src, f), 'utf8'));
});

test('both directories hold the same modules, so a deleted one fails too', () => {
  expect(modules(dst)).toEqual(modules(src));
});

test('deno.json maps every copied module to its .ts file, and nothing else', () => {
  const config = JSON.parse(readFileSync(join(functions, 'deno.json'), 'utf8')) as {
    imports?: Record<string, string>;
  };
  const scoring = Object.entries(config.imports ?? {}).filter(([k]) =>
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
