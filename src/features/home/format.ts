/**
 * Home's pure formatting helpers: no hooks and no data layer, so another feature (Insights) can
 * import them without loading the rewards hooks, the session or the app client.
 */

/**
 * A `YYYY-MM-DD` day as the card prints it ("Sep 21") and as it is spoken ("September 21"). The
 * year joins in only when it is not the current one, so a score that is months old says so.
 */
export function formatAsOfDay(day: string, now: number): { printed: string; spoken: string } {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { printed: day, spoken: day };
  const thisYear = new Date(now).getUTCFullYear() === date.getUTCFullYear();
  const opts = (month: 'short' | 'long'): Intl.DateTimeFormatOptions => ({
    month,
    day: 'numeric',
    timeZone: 'UTC',
    ...(thisYear ? null : { year: 'numeric' }),
  });
  return {
    printed: new Intl.DateTimeFormat('en-US', opts('short')).format(date),
    spoken: new Intl.DateTimeFormat('en-US', opts('long')).format(date),
  };
}
