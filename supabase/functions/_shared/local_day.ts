// The device's local day, derived on the server from the zone it named and the start instant, so
// the daily cap and "earlier today" can never be moved by a mislabelled `localDay`.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A zone NAME (the payload contract's TZ_NAME_PATTERN): never an offset such as `+05:00`, which
 * newer Intl accepts but Postgres reads with the opposite sign. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** The zone's formatter, or null when the name is not a zone name or Intl does not know it. */
function formatterFor(tz: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(tz);
  if (cached) return cached;
  if (!NAME_PATTERN.test(tz) || /^(posix|right)\//i.test(tz)) return null;
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(tz, f);
    return f;
  } catch {
    return null;
  }
}

/** An IANA zone name Intl can place a date in. */
export const isKnownTz = (tz: string): boolean => formatterFor(tz) !== null;

/** `YYYY-MM-DD` of `epochMs` in `tz`, or null for an unknown zone. */
export function localDayOf(epochMs: number, tz: string): string | null {
  const f = formatterFor(tz);
  if (!f) return null;
  // en-CA formats as YYYY-MM-DD already; rebuild from parts so a locale change cannot alter it.
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(epochMs))) if (p.type !== 'literal') parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}
