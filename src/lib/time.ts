/** The quiet-hours window used for night-driving context: 23:00 through 04:59 local. */
export function isNight(date: Date): boolean {
  const h = date.getHours();
  return h >= 23 || h < 5;
}

/** Calendar day as "YYYY-MM-DD" — in `tz` when given, otherwise in the device's zone. */
export function dayKey(date: Date, tz?: string): string {
  if (tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Solar elevation via the NOAA approximation; "down" below civil twilight (-6°). */
export function sunIsDown(date: Date, lat: number, lng: number): boolean {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const epsilon = (23.439 - 0.0000004 * n) * rad;
  const alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (((gmst + lng / 15) % 24) + 24) % 24;
  const H = lst * 15 * rad - alpha;
  const elevation = Math.asin(
    Math.sin(lat * rad) * Math.sin(delta) + Math.cos(lat * rad) * Math.cos(delta) * Math.cos(H),
  );
  return elevation / rad < -6;
}
