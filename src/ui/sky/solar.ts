/**
 * Sunrise, sunset and twilight on the phone, from the NOAA solar calculator's equations (the
 * Global Monitoring Laboratory's spreadsheet, after Meeus). Accurate to about a minute between
 * the polar circles, which is far finer than a theme needs. No network, no permission: it takes
 * whatever position the app already holds.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MIN = 60_000;

/** The sun's centre this far below the horizon is sunrise / sunset (refraction and radius). */
export const SUNRISE_ZENITH = 90.833;
/** Civil twilight: the sun 6° below the horizon. */
export const CIVIL_ZENITH = 96;

type SunAt = { declination: number; eqTimeMin: number };

function sunAt(ms: number): SunAt {
  const jd = ms / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  return { declination, eqTimeMin };
}

/** The sun's elevation above the horizon in degrees (geometric, no refraction). */
export function solarElevation(date: Date, lat: number, lng: number): number {
  const ms = date.getTime();
  const { declination, eqTimeMin } = sunAt(ms);
  const utcMin = (((ms % 86_400_000) + 86_400_000) % 86_400_000) / MIN;
  const trueSolar = (((utcMin + eqTimeMin + 4 * lng) % 1440) + 1440) % 1440;
  const hourAngle = trueSolar / 4 - 180;
  const cosZenith =
    Math.sin(lat * RAD) * Math.sin(declination * RAD) +
    Math.cos(lat * RAD) * Math.cos(declination * RAD) * Math.cos(hourAngle * RAD);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) * DEG;
}

export type SunTimes = {
  /** Solar noon of the day. */
  noon: Date;
  /** Civil dawn (sun 6° below), sunrise, sunset and civil dusk. Null when it never happens that day. */
  dawn: Date | null;
  sunrise: Date | null;
  sunset: Date | null;
  dusk: Date | null;
  /** The sun stays up all day (midnight sun) or stays down all day (polar night). */
  polar: 'day' | 'night' | null;
};

/** Hour angle in degrees for the sun at `zenith`, or null if it never gets there that day. */
function hourAngle(lat: number, declination: number, zenith: number): number | null {
  const cos =
    Math.cos(zenith * RAD) / (Math.cos(lat * RAD) * Math.cos(declination * RAD)) -
    Math.tan(lat * RAD) * Math.tan(declination * RAD);
  if (cos > 1 || cos < -1) return null;
  return Math.acos(cos) * DEG;
}

/**
 * The solar day around `date` at a place: the solar noon nearest `date` (so the day runs from one
 * solar midnight to the next, whatever the phone's time zone says), and the twilight and horizon
 * crossings either side of it.
 */
export function sunTimes(date: Date, lat: number, lng: number): SunTimes {
  const anchor = date.getTime();
  // Two passes: the second evaluates the sun at the noon the first found.
  let noonMs = anchor;
  let sun = sunAt(noonMs);
  for (let pass = 0; pass < 2; pass++) {
    const utcMidnight = Math.floor(noonMs / 86_400_000) * 86_400_000;
    let candidate = utcMidnight + (720 - 4 * lng - sun.eqTimeMin) * MIN;
    while (candidate - anchor > 12 * 60 * MIN) candidate -= 1440 * MIN;
    while (anchor - candidate > 12 * 60 * MIN) candidate += 1440 * MIN;
    noonMs = candidate;
    sun = sunAt(noonMs);
  }

  const at = (zenith: number, side: -1 | 1): Date | null => {
    // Refine each crossing once with the sun as it stands near that time.
    const first = hourAngle(lat, sun.declination, zenith);
    if (first === null) return null;
    const guess = noonMs + side * first * 4 * MIN;
    const s = sunAt(guess);
    const ha = hourAngle(lat, s.declination, zenith);
    if (ha === null) return new Date(guess);
    return new Date(noonMs + (sun.eqTimeMin - s.eqTimeMin) * MIN + side * ha * 4 * MIN);
  };

  const sunrise = at(SUNRISE_ZENITH, -1);
  const sunset = at(SUNRISE_ZENITH, 1);
  let polar: SunTimes['polar'] = null;
  if (sunrise === null) polar = solarElevation(new Date(noonMs), lat, lng) > -0.833 ? 'day' : 'night';
  return {
    noon: new Date(noonMs),
    dawn: at(CIVIL_ZENITH, -1),
    sunrise,
    sunset,
    dusk: at(CIVIL_ZENITH, 1),
    polar,
  };
}
