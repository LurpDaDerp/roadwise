/**
 * The words of a dangerous-weather alert (plan D14), on Home and on the driving screen: a title of
 * one to three words, one short line that says what is happening and what to do (about 60
 * characters at most), and the driving screen's warning: what to do, in four words at most.
 * Numbers are in the driver's units.
 */
import { isRoadGrip, isSightCap, type RoadStamp } from '@/core/road';

import { KMH_PER_MPH, type Units } from '@/lib/units';

import type { DangerAlert, DangerKind } from './danger';
import { SNOW_ROAD } from './thresholds';

export const WEATHER_TITLES: Readonly<Record<DangerKind, string>> = {
  blizzard: 'Blizzard',
  freezing_rain: 'Freezing rain',
  black_ice: 'Black ice',
  freezing_drizzle: 'Freezing drizzle',
  hail: 'Hail',
  high_wind: 'High winds',
  heavy_snow: 'Heavy snow',
  snow_on_road: 'Snowy roads',
  freezing_fog: 'Freezing fog',
  dense_fog: 'Dense fog',
  low_visibility: 'Low visibility',
  thunderstorm: 'Thunderstorm',
  heavy_rain: 'Heavy rain',
  standing_water: 'Standing water',
  strong_wind: 'Strong winds',
  rain_at_night: 'Rain at night',
};

/** The driving screen's warning under the title: what to do, at a glance (four words at most). */
export const WEATHER_ACTIONS: Readonly<Record<DangerKind, string>> = {
  blizzard: 'Stay off the road',
  freezing_rain: 'Easy on the brakes',
  black_ice: 'Easy on the brakes',
  freezing_drizzle: 'Easy on the brakes',
  hail: 'Pull over somewhere safe',
  high_wind: 'Hold the wheel firmly',
  heavy_snow: 'Leave extra room',
  snow_on_road: 'Take it slow',
  freezing_fog: 'Use your low beams',
  dense_fog: 'Use your low beams',
  low_visibility: 'Use your low beams',
  thunderstorm: 'Take it slow',
  heavy_rain: 'Ease off the gas',
  standing_water: 'Slow down for puddles',
  strong_wind: 'Hold the wheel firmly',
  rain_at_night: 'Leave extra room',
};

const GRIP = 'Hold the wheel firmly.';
const LOW_BEAMS = 'Slow down and use your low beams.';
const ICE = 'Go easy on the brakes.';

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
      return 'Wet roads below freezing. Watch bridges and shady spots.';
    case 'hail':
      return 'A hailstorm is nearby. Pull over somewhere safe.';
    case 'high_wind':
    case 'strong_wind':
      return a.gustMph === null ? `Strong, steady wind. ${GRIP}` : `${gusts(a.gustMph, units)}. ${GRIP}`;
    case 'heavy_snow':
      return 'Snow is piling up fast. Slow down and leave extra room.';
    case 'snow_on_road':
      return 'Fresh snow on the road. Take it slow.';
    case 'freezing_fog':
      return `Fog is icing the road. ${LOW_BEAMS}`;
    case 'dense_fog':
    case 'low_visibility':
      return a.visibilityM === null ? `You can't see far. ${LOW_BEAMS}` : `Visibility ${sight(a.visibilityM, units)}. ${LOW_BEAMS}`;
    case 'thunderstorm':
      return 'Lightning and downpours nearby. Take it slow.';
    case 'heavy_rain':
      return 'Water on the road. Ease off the gas to avoid hydroplaning.';
    case 'standing_water':
      return 'Water is pooling on the road. Slow down for puddles.';
    case 'rain_at_night':
      return 'Rain at night hides the lane lines. Leave extra room.';
  }
}

export const weatherTitle = (a: DangerAlert): string => WEATHER_TITLES[a.kind];

export const weatherAction = (a: DangerAlert): string => WEATHER_ACTIONS[a.kind];

/** What a screen reader hears for the whole alert. */
export const weatherLabel = (a: DangerAlert, units: Units): string => `Weather alert. ${weatherTitle(a)}. ${weatherLine(a, units)}`;

export const weatherCopy = {
  dismiss: 'Hide weather alert',
  dismissHint: 'Hides it until the weather changes.',
  /** The driving screen's ✕: hidden for the rest of this drive. */
  dismissDriveHint: 'Hides it for the rest of this drive.',
} as const;

/** "7:40 AM", "12:05 PM": a minute of the day on a 12-hour clock. */
export function clockOfMinute(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Where the commute goes, as the heads-up says it: "head home", "leave for work". */
const goingTo = (to: { kind: string; name: string }): string =>
  to.kind === 'home' ? 'head home' : to.kind === 'work' ? 'leave for work' : to.kind === 'school' ? 'leave for school' : `leave for ${to.name}`;

/**
 * The weather heads-up before the usual commute (a notification): the danger's title, then when and
 * what to do. "Expected around 7:40 AM, when you usually leave for work. Give yourself extra time."
 */
export const commuteHeadsUpCopy = {
  title: (kind: DangerKind): string => WEATHER_TITLES[kind],
  body: (kind: DangerKind, to: { kind: string; name: string }, clock: string): string =>
    `Expected around ${clock}, when you usually ${goingTo(to)}. ${kind === 'blizzard' ? 'Stay off the road if you can.' : 'Give yourself extra time.'}`,
} as const;

/**
 * The driving screen's card while the road state moves the warning lines (`./road.ts`): the road's
 * title when no alert names the weather, and the quiet line under the title in place of the advice.
 */
export const roadCopy = {
  sooner: 'Warnings come sooner',
} as const;

/** The Live Activity's weather kind for a wet road (its glyph): the one road state no alert kind fits. */
export const WET_ROAD_KIND = 'wet_road';

/** The Live Activity's weather kind for a road state (its glyph): the alert kind closest to it. */
export type RoadKind = 'black_ice' | 'snow_on_road' | 'heavy_rain' | typeof WET_ROAD_KIND | 'low_visibility';

/**
 * The road's title: the grip first (ice, snow, water, a wet film), then the sight cap. A wet road at
 * 1 °C or colder (`tempC`, the air now) reads "Slippery roads": it may be icing. Null when the
 * state moves no line.
 */
export function roadTitle(road: RoadStamp | null | undefined, tempC: number | null): string | null {
  switch (road?.g) {
    case 'ice':
      return 'Icy roads';
    case 'snow':
      return 'Snowy roads';
    case 'water':
      return 'Heavy rain';
    case 'wet':
      return tempC !== null && tempC <= SNOW_ROAD.maxTempC ? 'Slippery roads' : 'Wet roads';
  }
  return isSightCap(road?.cap) ? 'Low visibility' : null;
}

/** The Live Activity's weather kind for a road state, or null when it moves no line. */
export function roadKind(road: RoadStamp | null | undefined): RoadKind | null {
  switch (road?.g) {
    case 'ice':
      return 'black_ice';
    case 'snow':
      return 'snow_on_road';
    case 'water':
      return 'heavy_rain';
    case 'wet':
      return WET_ROAD_KIND;
  }
  return isSightCap(road?.cap) ? 'low_visibility' : null;
}

/**
 * What a screen reader hears for the card while the warning lines are moved: "Wet roads. Speeding
 * warnings come at a lower speed, and hard braking, start and turn warnings at a lighter touch."
 * The second part only when a grip moves the hard-event lines (visibility alone moves only the
 * speed's).
 */
export function roadSpoken(title: string, road: RoadStamp): string {
  const touch = isRoadGrip(road.g) ? ', and hard braking, start and turn warnings at a lighter touch' : '';
  return `${title}. Speeding warnings come at a lower speed${touch}.`;
}
