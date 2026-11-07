import { assert, assertEquals } from '@std/assert';
import { cachedFormatterCount, isKnownTz, localDayOf } from './local_day.ts';

/** Every upper/lower casing of `s`'s letters, up to `limit` of them. */
function casings(s: string, limit: number): string[] {
  const out: string[] = [];
  const letters = [...s].map((c, i) => (/[a-z]/i.test(c) ? i : -1)).filter((i) => i >= 0);
  for (let mask = 0; mask < limit && mask < 2 ** letters.length; mask++) {
    const chars = [...s.toLowerCase()];
    letters.forEach((pos, bit) => {
      if (mask & (1 << bit)) chars[pos] = chars[pos].toUpperCase();
    });
    out.push(chars.join(''));
  }
  return out;
}

Deno.test('case variants of a zone name give the same day but never grow the formatter cache', () => {
  const t = Date.UTC(2026, 9, 5, 2, 0); // 22:00 on Oct 4 in New York
  assertEquals(localDayOf(t, 'America/New_York'), '2026-10-04');
  const before = cachedFormatterCount();
  for (const tz of casings('America/Argentina/ComodRivadavia', 300)) assert(isKnownTz(tz), tz);
  for (const tz of casings('America/New_York', 300)) assertEquals(localDayOf(t, tz), '2026-10-04');
  // Two canonical zones at most were added, whatever the casings.
  assert(cachedFormatterCount() <= before + 2, `cache grew to ${cachedFormatterCount()}`);
});
