import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const src = join(__dirname, '..', '..', 'packages', 'scoring', 'src');
const dst = join(__dirname, '..', '..', 'supabase', 'functions', '_shared', 'scoring');
test('the edge-function copy of the scoring package is byte-identical', () => {
  for (const f of readdirSync(src)) expect(readFileSync(join(dst, f), 'utf8')).toBe(readFileSync(join(src, f), 'utf8'));
});
