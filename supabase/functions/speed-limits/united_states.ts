// Where a `maxspeed` with no unit is a US limit in mph (overpass.ts reads it).
//
// OpenStreetMap's default unit is km/h, so a bare `maxspeed=50` in Canada or Mexico is 50 km/h. A
// US road posts mph, and the bare numbers tagged on US roads ("25", "35") are mph too: the import
// pipeline reads them so (supabase/data/sql/parse_maxspeed.sql, inside Washington with the 49th
// parallel as the Canadian line). The fill works anywhere, so it needs to know which roads are in
// the United States.
//
//   * `US_AREAS` are boxes holding no land but the 50 states' and Puerto Rico's: the whole
//     interior, every box kept well clear of Canadian, Mexican, Bahamian and Caribbean land (each
//     comment names the nearest). The one exception is the 49th parallel west of Lake of the
//     Woods, taken as the border exactly, as the import takes it; the Canadian land south of it, on
//     and around southern Vancouver Island, is cut back out (`CANADA_SOUTH_OF_49`).
//   * Beside the whole Mexican border, and the Canadian one where it winds (the St Clair, Detroit,
//     Niagara and St Lawrence rivers, Maine's, the Alaska panhandle's), the boxes stop short of
//     it, leaving a strip of the United States outside them, in places tens of kilometres wide
//     (Detroit, Buffalo, Yuma, El Paso, Laredo and the Rio Grande valley lie in it). A road wholly
//     in that strip is read as everywhere outside the boxes, km/h, and one running from a box into
//     it gives no limit from a bare number, like any road crossing out of them: a box that reached
//     too far would read Canadian or Mexican roads as mph, which is worse.
//
// Each box is [south, north, west, east] in degrees, edges included.
type Box = readonly [minLat: number, maxLat: number, minLng: number, maxLng: number];

export const US_AREAS: readonly Box[] = [
  // The West, west of Lake of the Woods (-95.15): north to the 49th parallel; Mexico's highest
  // point is 32.72 (where the California line meets the Colorado River).
  [32.75, 49.0, -124.8, -95.2],
  // San Diego: the border runs at 32.53..32.56 here.
  [32.6, 32.75, -117.35, -116.9],
  // Southern Arizona: the border line from the Colorado River to Nogales is at 32.40 by -114.5 and
  // 31.93 by -113.0; east of Nogales it is the parallel 31.33.
  [32.6, 32.75, -114.5, -113.0],
  [32.2, 32.75, -113.0, -111.0],
  [31.45, 32.75, -111.0, -108.3],
  // New Mexico and Texas north of the border's parallel 31.78 (El Paso).
  [31.9, 32.75, -108.3, -95.2],
  // Texas along the Rio Grande, a step at a time: the river is at or south of 31.1 by -105.6, 30.65
  // by -105.0, 29.92 by -104.5 (the Lower Canyons included), 28.1 by -100.0, 26.7 by -99.2
  // (Falcon Lake) and 26.25 by -98.5.
  [31.3, 31.9, -105.6, -105.0],
  [30.8, 31.9, -105.0, -104.5],
  [30.1, 31.9, -104.5, -95.2],
  [28.6, 30.1, -100.0, -95.2],
  [27.0, 28.6, -99.2, -98.5],
  [26.6, 28.6, -98.5, -95.2],
  // The Gulf coast to Lake Erie and the Atlantic: Canada's southernmost land is Middle Island
  // (41.68); Cuba and the Cay Sal Bank lie south of 24.2, Bimini (-79.3) and Walker's Cay (27.27)
  // are the nearest of the Bahamas, Bermuda is east of -64.9.
  [24.4, 41.6, -95.2, -79.8],
  [27.5, 41.6, -79.8, -65.5],
  // The Upper Midwest: Lake Michigan is all US; the border is at or north of 48.0 (the Pigeon
  // River) east of -93.5 and of 48.6 (the Rainy River) west of it.
  [41.6, 46.5, -95.2, -87.0],
  [46.5, 47.9, -93.5, -87.0],
  [46.5, 48.5, -95.2, -93.5],
  // Michigan: Canada's Detroit River islands lie east of -83.14, Manitoulin and Cockburn Island
  // north of 45.8, St Joseph Island north of 46.05, Whitefish Bay's Ontario shore east of -84.75
  // and Caribou Island north of 47.3.
  [41.6, 45.6, -87.0, -83.25],
  [45.6, 46.0, -87.0, -84.0],
  [46.0, 46.9, -87.0, -84.95],
  // Ohio, Pennsylvania and New York along Lakes Erie and Ontario and the St Lawrence: Point Pelee
  // and Canada's Lake Erie islands are west of -82.45 and the Ontario shore north of 42.1 east of
  // it; Long Point is north of 42.54; the shore east of -79.8 north of 42.85; Fort Erie and the
  // Niagara River west of -78.9; Lake Ontario's north shore north of 43.8; Main Duck Island west
  // of -76.6 and Wolfe Island north of 44.1; the Canadian islands and shore of the St Lawrence
  // west of -75.75 or north of 44.55, and north of 44.9 east of -75.0.
  [41.6, 42.0, -82.3, -80.5],
  [41.6, 42.35, -80.5, -74.6],
  [42.35, 42.7, -79.8, -74.6],
  [42.7, 43.4, -78.6, -74.6],
  [43.4, 44.0, -76.4, -74.6],
  [44.0, 44.45, -75.6, -74.6],
  [44.45, 44.75, -75.0, -74.6],
  // New York's North Country and New England: the Quebec line is at or north of 45.0 (Akwesasne's
  // Quebec side included) and west of -71.15 south of 45.2; New Brunswick is east of -67.45 below
  // 45.2 (the St Croix), east of -67.0 on the coast (Campobello, Grand Manan), east of -67.79
  // above it; the St John River is north of 47.0 and Quebec west of -69.8 by 46.9 and west of
  // -70.25 below 45.8.
  [41.6, 44.96, -74.6, -71.0],
  [41.6, 45.2, -71.0, -67.9],
  [41.6, 44.85, -67.9, -67.15],
  [45.2, 45.8, -70.0, -68.0],
  [45.8, 46.9, -69.3, -67.95],
  // Alaska: Yukon is east of -141.0 and Russia's Big Diomede west of -169.0; west of that,
  // Chukotka's shore is north of 64.3 and the Commander Islands west of 168.1 (east longitude),
  // past the Aleutians' end at Attu (172.9); in the panhandle, Haida Gwaii is south of 54.3 and
  // British Columbia east of -131.05 (Zayas Island) by Ketchikan and east of -133.7 by Juneau.
  [51.0, 71.5, -168.5, -141.1],
  [51.0, 63.85, -180.0, -168.5],
  [51.0, 53.2, 172.0, 180.0],
  [54.6, 56.5, -134.2, -131.3],
  [56.5, 58.6, -137.0, -134.2],
  // Hawaii.
  [18.8, 22.4, -160.6, -154.7],
  // Puerto Rico with Vieques and Culebra (it posts mph like the states): the Dominican Republic is
  // west of -68.3 and the British Virgin Islands east of -64.85; uninhabited Mona and Desecheo stay out.
  [17.85, 18.55, -67.3, -65.2],
];

/**
 * Canadian land inside `US_AREAS`' western box, south of the 49th parallel: each box holds all of
 * it near it and swallows a little US land rather than miss any (US land in one is read as km/h,
 * as outside the boxes).
 */
export const CANADA_SOUTH_OF_49: readonly Box[] = [
  // Vancouver Island south of 49, Saanich and the western Gulf Islands (and the US's Henry Island
  // and western Stuart Island); Cape Flattery's Tatoosh Island (48.39) stays out.
  [48.4, 49.0, -124.8, -123.18],
  // Sooke, Metchosin, Victoria's south shore and Discovery Island: the Olympic Peninsula's shore
  // here is south of 48.25.
  [48.29, 48.45, -124.12, -123.18],
  // Pender, Saturna, Mayne and Tumbo: Waldron and Stuart (US) lie south of 48.73, Patos east of
  // -123.0, Point Roberts north of 48.95.
  [48.72, 48.9, -123.18, -123.03],
];

const holds = ([minLat, maxLat, minLng, maxLng]: Box, lat: number, lng: number): boolean =>
  lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;

/** True when the point lies in `US_AREAS` and outside `CANADA_SOUTH_OF_49`. */
export function inUnitedStates(lat: number, lng: number): boolean {
  return US_AREAS.some((b) => holds(b, lat, lng)) && !CANADA_SOUTH_OF_49.some((b) => holds(b, lat, lng));
}

/**
 * How a `maxspeed` with no unit is read on one road: mph when every point of its line is in the
 * United States, km/h when none is, and not at all (no limit) when it crosses out of them, as the
 * import drops a bare number on a road reaching over the 49th parallel.
 */
export type BareUnit = 'kmh' | 'mph' | 'none';

/** The bare unit for a line of `[lng, lat]` pairs (GeoJSON order, as osm.ways stores them). */
export function bareUnitOf(line: readonly (readonly [number, number])[]): BareUnit {
  let inside = 0;
  for (const [lng, lat] of line) if (inUnitedStates(lat, lng)) inside += 1;
  return inside === 0 ? 'kmh' : inside === line.length ? 'mph' : 'none';
}
