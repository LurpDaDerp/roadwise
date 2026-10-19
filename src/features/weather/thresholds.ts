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
 *   - Freezing Fog Advisory: fog cutting visibility to 1/4 mile or less at or below 32 °F (0 °C).
 *   - Blizzard Warning: sustained wind or frequent gusts of 35 mph or more with falling or blowing
 *     snow, visibility under 1/4 mile (AMS Glossary "Blizzard": 16 m/s and under 400 m).
 *   - Winter Weather Advisory: any freezing rain accretion, or black ice on the roads.
 *   - Severe Thunderstorm Warning: hail 1 inch or larger, or gusts of 58 mph or more. A
 *     thunderstorm below that counts only with at least moderate rain: the downpour is what hides
 *     the road and floats the tyres; lightning does not reach a driver in a closed car.
 * - Precipitation intensity (AMS Glossary of Meteorology "Rain",
 *   https://glossary.ametsoc.org/wiki/Rain; the Federal Meteorological Handbook FMH-1): moderate
 *   rain is 0.11-0.30 in (2.6-7.6 mm) an hour, heavy rain more than 0.30 in (7.6 mm) an hour, and
 *   anything under 2.6 mm an hour is light rain or drizzle; snow is heavy when it cuts
 *   visibility to 1/4 mile or less. There is no national snowfall-rate criterion; NWS offices use
 *   1 in (2.5 cm) an hour as the heavy-snowfall rate at which "it becomes difficult for road crews
 *   to keep up" (e.g. NWS Peachtree City's spotter guide,
 *   https://www.weather.gov/media/ffc/snow_measurement_guidelines.pdf, and NWS Mount Holly's
 *   "1 to 2 inches per hour will make travel difficult or impossible").
 * - Rain in the dark: darkness and rain each raise the crash risk, and together far more than
 *   either alone. On Dutch rural roads (Wanvik 2009, Accident Analysis & Prevention 41(1), in the
 *   FHWA CMF Clearinghouse, https://cmfclearinghouse.fhwa.dot.gov/study_detail.php?stid=194) rain
 *   in the dark raised the injury-crash risk about 50 % on lit roads and 190 % on unlit ones; SWOV
 *   finds rain at night "a far greater hazard than rain during daytime". Wet lane markings stop
 *   reflecting headlights once water covers them (FHWA wet-night retroreflectivity work), which a
 *   drizzle does not do but a moderate rain does. So rain counts at night from the AMS moderate
 *   rate (2.6 mm an hour) up; lighter rain at night, and moderate rain by day, do not.
 * - Water standing on the road: NWS offices issue Flood Advisories for "ponding of water on
 *   roadways" at sustained rates as low as 0.25 in (6.4 mm) an hour, and flash-flood guidance
 *   for 3 hours on natural ground starts near 1.3 in (33 mm), lower in towns where pavement sheds
 *   the water (NWS River Forecast Centers, e.g. https://www.weather.gov/nerfc/ffg). Rain intensity
 *   is the largest driver of the water film that makes tyres hydroplane (TRB, water film depth
 *   models), and a film over 2 mm is where the risk starts (Huebner et al. 1986). So 0.75 in
 *   (19 mm) in the last 3 hours, that 0.25 in an hour held for 3 hours, counts as water standing
 *   on the road even once the rain has eased.
 * - Snow on the road: 1 in (2.5 cm) of fresh snow is the lowest NWS Winter Weather Advisory snow
 *   criterion (the southern offices, e.g. NWS Peachtree City), the depth at which an untreated
 *   road turns white and slick. It counts for 6 hours after it falls while the air is at or below
 *   1 °C: a road surface runs colder than the air at 2 m, so slush and packed snow outlast a
 *   reading just above freezing.
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
  /** Moderate rain: 0.26 cm (2.6 mm) an hour; less is light rain or drizzle. */
  moderateRainMmH: 2.6,
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

/** Rain at night: rain at a moderate rate or more while it is dark (Open-Meteo's `is_day` is 0). */
export const NIGHT_RAIN = {
  rainMmH: RATE.moderateRainMmH,
} as const;

/** Water standing on the road: this much rain over the last few hours, even if it has eased. */
export const STANDING_WATER = {
  /** 0.75 in: 0.25 in (6.4 mm) an hour, the NWS ponding rate, held for 3 hours. */
  rainMm: 19,
  /** How far back the rain counts (the same window as black ice). */
  lookbackHours: ICE.lookbackHours,
} as const;

/** Snow on the road: fresh snow that has not had time to clear, in near-freezing air. */
export const SNOW_ROAD = {
  /** 1 in: the lowest NWS Winter Weather Advisory snowfall. */
  snowCm: 2.5,
  /** Air at or below this, °C (the road runs colder than the air). */
  maxTempC: 1,
  /** How far back the snow counts. */
  lookbackHours: 6,
} as const;

/** How far back the reading asks: the longest lookback above. */
export const PAST_HOURS = Math.max(ICE.lookbackHours, STANDING_WATER.lookbackHours, SNOW_ROAD.lookbackHours);

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
