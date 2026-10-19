/**
 * The words of a dangerous-weather alert (plan D14), on Home and on the driving screen: a title of
 * one to three words and one short line that says what is happening and what to do (about 60
 * characters at most). Numbers are in the driver's units.
 */
import { KMH_PER_MPH, type Units } from '@/lib/units';

import type { DangerAlert, DangerKind } from './danger';

export const WEATHER_TITLES: Readonly<Record<DangerKind, string>> = {
  blizzard: 'Blizzard',
  freezing_rain: 'Freezing rain',
  black_ice: 'Black ice',
  freezing_drizzle: 'Freezing drizzle',
  hail: 'Hail',
  high_wind: 'High winds',
  heavy_snow: 'Heavy snow',
  freezing_fog: 'Freezing fog',
  dense_fog: 'Dense fog',
  low_visibility: 'Low visibility',
  thunderstorm: 'Thunderstorm',
  heavy_rain: 'Heavy rain',
  strong_wind: 'Strong winds',
};

const HANDS = 'Keep both hands on the wheel.';
const LOW_BEAMS = 'Slow down, low beams on.';
const ICE = 'Slow down, brake gently.';

/** "Gusts to 52 mph" / "Gusts to 84 km/h". */
const gusts = (mph: number, units: Units): string =>
  units === 'km' ? `Gusts to ${Math.round(mph * KMH_PER_MPH)} km/h` : `Gusts to ${Math.round(mph)} mph`;

/** "650 ft" / "200 m", to the nearest 50 and never 0. */
const sight = (m: number, units: Units): string => {
  const v = units === 'km' ? m : m * 3.28084;
  return `${Math.max(50, Math.round(v / 50) * 50)} ${units === 'km' ? 'm' : 'ft'}`;
};

/** The one line under the title. */
export function weatherLine(a: DangerAlert, units: Units): string {
  switch (a.kind) {
    case 'blizzard':
      return 'Snow and wind hide the road. Stay off it if you can.';
    case 'freezing_rain':
      return `Rain is freezing on the road. ${ICE}`;
    case 'freezing_drizzle':
      return `Drizzle is freezing on the road. ${ICE}`;
    case 'black_ice':
      return 'Wet roads below freezing. Watch bridges and shade.';
    case 'hail':
      return 'Storm with hail nearby. Pull over somewhere safe.';
    case 'high_wind':
    case 'strong_wind':
      return a.gustMph === null ? `Strong, steady wind. ${HANDS}` : `${gusts(a.gustMph, units)}. ${HANDS}`;
    case 'heavy_snow':
      return 'Snow is piling up fast. Slow down, leave more room.';
    case 'freezing_fog':
      return `Fog is icing the road. ${LOW_BEAMS}`;
    case 'dense_fog':
    case 'low_visibility':
      return a.visibilityM === null ? `You can't see far. ${LOW_BEAMS}` : `Visibility ${sight(a.visibilityM, units)}. ${LOW_BEAMS}`;
    case 'thunderstorm':
      return 'Lightning and downpours nearby. Slow down.';
    case 'heavy_rain':
      return 'Water on the road. Slow down to avoid hydroplaning.';
  }
}

export const weatherTitle = (a: DangerAlert): string => WEATHER_TITLES[a.kind];

/** What a screen reader hears for the whole alert. */
export const weatherLabel = (a: DangerAlert, units: Units): string => `Weather alert. ${weatherTitle(a)}. ${weatherLine(a, units)}`;

export const weatherCopy = {
  dismiss: 'Hide weather alert',
  dismissHint: 'Hides it until the weather changes.',
  /** The driving screen's ✕: hidden for the rest of this drive. */
  dismissDriveHint: 'Hides it for the rest of this drive.',
} as const;
