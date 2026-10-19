/**
 * When the weather is dangerous enough to drive in to say so (plan D14). Only conditions that
 * change how a car stops, steers or sees count; a wet or windy day does not. Every number is a
 * published criterion, picked at the conservative end so an alert is rare and means something.
 *
 * Sources:
 * - NWS warning and advisory criteria (NWS Directive 10-515; the national values as the offices
 *   publish them, e.g. https://www.weather.gov/jkl/criteria and the NWS Albany wind fact sheet
 *   https://www.weather.gov/media/aly/FactSheets/NYSWind.pdf):
 *   - Wind Advisory: sustained 31-39 mph for an hour, or gusts 46-57 mph.
 *   - High Wind Warning: sustained 40 mph or more for an hour, or gusts 58 mph or more.
 *   - Dense Fog Advisory: fog cutting visibility to 1/4 mile or less.
 *   - Blizzard Warning: sustained wind or frequent gusts of 35 mph or more with falling or blowing
 *     snow, visibility under 1/4 mile (AMS Glossary "Blizzard": 16 m/s and under 400 m).
 *   - Winter Weather Advisory: any freezing rain accretion, or black ice on the roads.
 *   - Severe Thunderstorm Warning: hail 1 inch or larger, or gusts of 58 mph or more.
 * - Precipitation intensity (AMS Glossary of Meteorology "Rain"; the Federal Meteorological
 *   Handbook FMH-1): heavy rain is more than 0.30 in (7.6 mm) an hour; snow is heavy when it cuts
 *   visibility to 1/4 mile or less. There is no national snowfall-rate criterion; NWS offices use
 *   1 in (2.5 cm) an hour as the heavy-snowfall rate at which "it becomes difficult for road crews
 *   to keep up" (e.g. NWS Peachtree City's spotter guide,
 *   https://www.weather.gov/media/ffc/snow_measurement_guidelines.pdf, and NWS Mount Holly's
 *   "1 to 2 inches per hour will make travel difficult or impossible").
 * - FHWA Road Weather Management (https://ops.fhwa.dot.gov/weather/roadimpact.htm): low visibility,
 *   pavement friction (rain, snow, ice) and vehicle stability (high wind) are the weather's three
 *   ways into crash risk.
 * - WMO weather interpretation codes as Open-Meteo reports them (https://open-meteo.com/en/docs):
 *   45 fog, 48 depositing rime fog, 56/57 freezing drizzle, 66/67 freezing rain, 71-77 snow,
 *   85/86 snow showers, 95 thunderstorm, 96/99 thunderstorm with hail (97 heavy thunderstorm).
 */

/** The NWS's 1/4 mile, in metres: dense fog, heavy snow by visibility, a blizzard. */
export const QUARTER_MILE_M = 402;

/** Wind, in mph (Open-Meteo is asked for mph so these read as the NWS writes them). */
export const WIND = {
  /** Wind Advisory gusts: "Strong winds". */
  advisoryGustMph: 46,
  /** High Wind Warning gusts: "High winds". */
  warningGustMph: 58,
  /** High Wind Warning sustained wind. */
  warningSustainedMph: 40,
  /** Blizzard: sustained or gusts. */
  blizzardMph: 35,
} as const;

/** Precipitation rates, per hour. */
export const RATE = {
  /** Heavy rain: more than 0.30 in (7.6 mm) an hour. */
  heavyRainMmH: 7.6,
  /** Heavy snowfall: 1 in (2.5 cm) an hour. */
  heavySnowCmH: 2.5,
} as const;

/** Black ice: air at or below freezing after this much rain or drizzle in the last few hours. */
export const ICE = {
  freezingC: 0,
  /** Enough water to wet the road, not a stray drop (mm of rain and showers). */
  wetRoadMm: 0.5,
  /** How far back the rain counts. */
  lookbackHours: 3,
} as const;

/** How far ahead an alert looks: the current conditions and the next 2 hours. */
export const LOOKAHEAD_HOURS = 2;

/** WMO weather codes. */
export const WMO = {
  fog: [45, 48],
  rimeFog: 48,
  freezingDrizzle: [56, 57],
  freezingRain: [66, 67],
  snow: [71, 73, 75, 77, 85, 86],
  thunderstorm: [95, 97],
  hail: [96, 99],
} as const;
