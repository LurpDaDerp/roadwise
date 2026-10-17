import { sunTimes } from './solar';

/**
 * The time of day the theme follows. Four phases, each with its own scheme:
 *
 * - `night` (dark): from civil dusk to civil dawn.
 * - `dawn` (light, warm): civil dawn until 45 min after sunrise.
 * - `day` (light).
 * - `dusk` (dark, warm): 30 min before sunset until civil dusk.
 *
 * Inside dawn and dusk a `glow` (0..1) peaks at sunrise / sunset and shades how warm the sky is.
 * The reading also says when it next changes, so the theme re-reads only then (a phase boundary,
 * or every 10 min inside a twilight window for the glow), never on a fast timer.
 */

export type SkyPhase = 'night' | 'dawn' | 'day' | 'dusk';
export type Scheme = 'light' | 'dark';

export type Place = { lat: number; lng: number };

export type PhaseReading = {
  phase: SkyPhase;
  scheme: Scheme;
  /** Twilight warmth, 0..1; 0 outside dawn and dusk. */
  glow: number;
  /** Epoch ms of the next moment the reading can change. */
  nextAt: number;
  /** Where the times came from: the sun at a known place, or the 07:00 / 19:00 clock fallback. */
  source: 'sun' | 'clock';
};

export const PHASE_SCHEME: Readonly<Record<SkyPhase, Scheme>> = {
  night: 'dark',
  dawn: 'light',
  day: 'light',
  dusk: 'dark',
};

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Dawn runs on this long after sunrise; dusk starts this long before sunset. */
export const DAWN_AFTER_SUNRISE_MIN = 45;
export const DUSK_BEFORE_SUNSET_MIN = 30;
/** Where the sun never reaches civil twilight depth, twilight is this long either side. */
const TWILIGHT_FALLBACK_MIN = 30;
/** The glow is re-read this often inside a twilight window. */
export const TWILIGHT_STEP_MS = 10 * MIN;
/** With no position at all: sunrise 07:00 and sunset 19:00 on the phone's clock. */
export const CLOCK_SUNRISE_H = 7;
export const CLOCK_SUNSET_H = 19;

type Windows = { dawnStart: number; sunrise: number; dayStart: number; duskStart: number; sunset: number; nightStart: number };

function sunWindows(at: Date, place: Place): Windows | 'day' | 'night' {
  const s = sunTimes(at, place.lat, place.lng);
  if (s.polar) return s.polar;
  if (!s.sunrise || !s.sunset) return 'day';
  const sunrise = s.sunrise.getTime();
  const sunset = s.sunset.getTime();
  return {
    dawnStart: s.dawn?.getTime() ?? sunrise - TWILIGHT_FALLBACK_MIN * MIN,
    sunrise,
    dayStart: sunrise + DAWN_AFTER_SUNRISE_MIN * MIN,
    duskStart: sunset - DUSK_BEFORE_SUNSET_MIN * MIN,
    sunset,
    nightStart: s.dusk?.getTime() ?? sunset + TWILIGHT_FALLBACK_MIN * MIN,
  };
}

function clockWindows(at: Date, dayOffset = 0): Windows {
  const base = (h: number, m = 0) =>
    new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayOffset, h, m).getTime();
  const sunrise = base(CLOCK_SUNRISE_H);
  const sunset = base(CLOCK_SUNSET_H);
  return {
    dawnStart: sunrise - TWILIGHT_FALLBACK_MIN * MIN,
    sunrise,
    dayStart: sunrise + DAWN_AFTER_SUNRISE_MIN * MIN,
    duskStart: sunset - DUSK_BEFORE_SUNSET_MIN * MIN,
    sunset,
    nightStart: sunset + TWILIGHT_FALLBACK_MIN * MIN,
  };
}

/** How warm a twilight is: 1 at the sun's crossing, easing to 0.4 at the window's ends. */
function glowAround(now: number, start: number, peak: number, end: number): number {
  const span = now <= peak ? peak - start : end - peak;
  if (span <= 0) return 1;
  const off = Math.min(1, Math.abs(now - peak) / span);
  return Math.round((1 - 0.6 * off * off) * 100) / 100;
}

function read(now: number, w: Windows, next: () => number, source: PhaseReading['source']): PhaseReading {
  const step = (until: number) => Math.min(until, now + TWILIGHT_STEP_MS);
  if (now < w.dawnStart) return { phase: 'night', scheme: 'dark', glow: 0, nextAt: w.dawnStart, source };
  if (now < w.dayStart)
    return { phase: 'dawn', scheme: 'light', glow: glowAround(now, w.dawnStart, w.sunrise, w.dayStart), nextAt: step(w.dayStart), source };
  if (now < w.duskStart) return { phase: 'day', scheme: 'light', glow: 0, nextAt: w.duskStart, source };
  if (now < w.nightStart)
    return { phase: 'dusk', scheme: 'dark', glow: glowAround(now, w.duskStart, w.sunset, w.nightStart), nextAt: step(w.nightStart), source };
  return { phase: 'night', scheme: 'dark', glow: 0, nextAt: next(), source };
}

/**
 * The phase at `now`. With a place, from the sun there; without one, from the phone's clock
 * (sunrise 07:00, sunset 19:00).
 */
export function readPhase(now: Date, place: Place | null): PhaseReading {
  const t = now.getTime();
  if (!place) {
    return read(t, clockWindows(now), () => clockWindows(now, 1).dawnStart, 'clock');
  }
  const w = sunWindows(now, place);
  if (w === 'day' || w === 'night') {
    // Midnight sun or polar night: one phase all day; look again in an hour.
    return { phase: w, scheme: PHASE_SCHEME[w], glow: 0, nextAt: t + HOUR, source: 'sun' };
  }
  const nextDawn = () => {
    const tomorrow = sunWindows(new Date(t + 24 * HOUR), place);
    return typeof tomorrow === 'string' ? t + HOUR : Math.max(tomorrow.dawnStart, t + MIN);
  };
  return read(t, w, nextDawn, 'sun');
}
