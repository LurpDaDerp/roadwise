import { assert, assertEquals } from '@std/assert';
import { bareUnitOf, CANADA_SOUTH_OF_49, inUnitedStates, US_AREAS } from './united_states.ts';

/** [name, lat, lng] */
type Place = readonly [string, number, number];

// Across the country and next to each border, so a box drawn too far shows here.
const US: readonly Place[] = [
  ['Seattle', 47.6062, -122.3321],
  ['Spokane', 47.6588, -117.426],
  ['Blaine, by the Peace Arch', 48.9937, -122.7471],
  ['Point Roberts', 48.985, -123.06],
  ['Friday Harbor', 48.5343, -123.0171],
  ['Neah Bay', 48.368, -124.616],
  ['Port Angeles', 48.1181, -123.4307],
  ['Portland, OR', 45.5152, -122.6784],
  ['Los Angeles', 34.0522, -118.2437],
  ['San Diego', 32.7157, -117.1611],
  ['Chula Vista', 32.6401, -117.0842],
  ['El Centro', 32.792, -115.5631],
  ['Phoenix', 33.4484, -112.074],
  ['Tucson', 32.2226, -110.9747],
  ['Sierra Vista', 31.5455, -110.2773],
  ['Las Cruces', 32.3199, -106.7637],
  ['Denver', 39.7392, -104.9903],
  ['Dallas', 32.7767, -96.797],
  ['Midland, TX', 31.9973, -102.0779],
  ['Alpine, TX', 30.3585, -103.661],
  ['Austin', 30.2672, -97.7431],
  ['San Antonio', 29.4241, -98.4936],
  ['Houston', 29.7604, -95.3698],
  ['Corpus Christi', 27.8006, -97.3964],
  ['Miami', 25.7617, -80.1918],
  ['Key West', 24.5551, -81.78],
  ['New York', 40.7128, -74.006],
  ['Chicago', 41.8781, -87.6298],
  ['Minneapolis', 44.9778, -93.265],
  ['Duluth', 46.7867, -92.1005],
  ['Warroad, MN', 48.905, -95.3141],
  ['Grand Rapids, MI', 42.9634, -85.6681],
  ['Toledo', 41.6528, -83.5379],
  ['Marquette, MI', 46.5476, -87.3956],
  ['St. Ignace, MI', 45.866, -84.7275],
  ['Cleveland', 41.4993, -81.6944],
  ['Erie, PA', 42.1292, -80.0851],
  ['Rochester, NY', 43.1566, -77.6088],
  ['Syracuse', 43.0481, -76.1474],
  ['Watertown, NY', 43.9748, -75.9108],
  ['Plattsburgh', 44.6995, -73.4529],
  ['Burlington, VT', 44.4759, -73.2121],
  ['Boston', 42.3601, -71.0589],
  ['Portland, ME', 43.6591, -70.2568],
  ['Bangor', 44.8012, -68.7778],
  ['Presque Isle, ME', 46.6812, -68.0159],
  ['Anchorage', 61.2181, -149.9003],
  ['Fairbanks', 64.8378, -147.7164],
  ['Juneau', 58.3019, -134.4197],
  ['Ketchikan', 55.3422, -131.6461],
  ['Unalaska', 53.8739, -166.5375],
  ['Adak', 51.88, -176.6581],
  ['Gambell, St. Lawrence Island', 63.7797, -171.7406],
  ['Shemya', 52.7239, 174.1136],
  ['Honolulu', 21.3069, -157.8583],
  ['San Juan', 18.4655, -66.1057],
  ['Ponce', 18.0111, -66.6141],
  ['Mayagüez', 18.2013, -67.1452],
  ['Rincón', 18.3402, -67.2499],
  ['Culebra', 18.303, -65.301],
  ['Vieques', 18.1494, -65.4428],
];

const ABROAD: readonly Place[] = [
  // British Columbia, south of the 49th parallel and north of it
  ['Victoria', 48.4284, -123.3656],
  ['Oak Bay', 48.4264, -123.3168],
  ['Sooke', 48.3742, -123.7266],
  ['Port Renfrew', 48.5546, -124.4207],
  ['Sidney, BC', 48.6505, -123.3986],
  ['Duncan, BC', 48.7787, -123.7079],
  ['Saturna Island, East Point', 48.783, -123.046],
  ['Mayne Island', 48.845, -123.29],
  ['Vancouver, BC', 49.2827, -123.1207],
  ['Surrey, BC', 49.1913, -122.849],
  // the rest of Canada along the border
  ['Winnipeg', 49.8951, -97.1384],
  ['Fort Frances', 48.6089, -93.4016],
  ['Thunder Bay', 48.3809, -89.2477],
  ['Sault Ste. Marie, ON', 46.5219, -84.3461],
  ['Windsor', 42.3149, -83.0364],
  ['Leamington', 42.0534, -82.5999],
  ['Pelee Island', 41.77, -82.65],
  ['Point Pelee', 41.91, -82.51],
  ['Fort Erie', 42.9017, -78.9722],
  ['Niagara Falls, ON', 43.0896, -79.0849],
  ['Toronto', 43.6532, -79.3832],
  ['Kingston, ON', 44.2312, -76.486],
  ['Brockville', 44.5895, -75.6843],
  ['Cornwall, ON', 45.0213, -74.7303],
  ['Saint-Régis, QC', 44.9975, -74.6494],
  ['Montreal', 45.5017, -73.5673],
  ['Stanstead, QC', 45.0045, -72.0977],
  ['St. Stephen, NB', 45.1922, -67.2776],
  ['Campobello Island', 44.88, -66.93],
  ['Grand Manan', 44.7, -66.8],
  ['Prince Rupert', 54.315, -130.3208],
  ['Masset, Haida Gwaii', 54.0119, -132.1453],
  ['Stewart, BC', 55.9361, -129.9904],
  ['Atlin, BC', 59.578, -133.69],
  ['Beaver Creek, YT', 62.38, -140.87],
  // Mexico along the border
  ['Tijuana', 32.5149, -117.0382],
  ['Mexicali', 32.6245, -115.4523],
  ['San Luis Río Colorado', 32.4561, -114.7719],
  ['Nogales, Sonora', 31.3086, -110.9422],
  ['Ciudad Juárez', 31.6904, -106.4245],
  ['Ojinaga', 29.5644, -104.4164],
  ['Ciudad Acuña', 29.3232, -100.9522],
  ['Piedras Negras', 28.7, -100.5236],
  ['Nuevo Laredo', 27.4864, -99.5069],
  ['Reynosa', 26.0508, -98.2979],
  ['Matamoros', 25.869, -97.5027],
  // the Bahamas, Cuba, Bermuda, Russia
  ['Bimini', 25.7262, -79.297],
  ['Freeport', 26.5333, -78.7],
  ['Havana', 23.1136, -82.3666],
  ['Hamilton, Bermuda', 32.2949, -64.7814],
  ['Big Diomede', 65.78, -169.05],
  ['Provideniya', 64.4233, -173.2258],
  ['Bering Island (Nikolskoye)', 55.1981, 165.9983],
  // the Caribbean beside Puerto Rico
  ['Punta Cana', 18.582, -68.4055],
  ['Santo Domingo', 18.4861, -69.9312],
  ['Road Town, Tortola', 18.4286, -64.6185],
  ['Jost Van Dyke', 18.445, -64.75],
  // and elsewhere
  ['Berlin', 52.52, 13.405],
  ['Sydney', -33.8688, 151.2093],
];

Deno.test('the US areas hold the 50 states and Puerto Rico, across the country and beside every border', () => {
  for (const [name, lat, lng] of US) assert(inUnitedStates(lat, lng), name);
});

Deno.test('no Canadian, Mexican or other foreign place near the US lies in them (BC south of 49 is cut out)', () => {
  for (const [name, lat, lng] of ABROAD) assert(!inUnitedStates(lat, lng), name);
});

Deno.test('every box is south-to-north and west-to-east, and the BC cut-outs lie inside the western box', () => {
  for (const [s, n, w, e] of [...US_AREAS, ...CANADA_SOUTH_OF_49]) assert(s < n && w < e, `${s},${n},${w},${e}`);
  const west = US_AREAS[0]!;
  for (const [s, n, w, e] of CANADA_SOUTH_OF_49) assert(s >= west[0] && n <= west[1] && w >= west[2] && e <= west[3]);
});

Deno.test('a line reads mph wholly in the US, km/h wholly outside, and neither across the edge', () => {
  assertEquals(bareUnitOf([[-122.33, 47.6], [-122.32, 47.61]]), 'mph');
  assertEquals(bareUnitOf([[-123.37, 48.43], [-123.36, 48.44]]), 'kmh');
  assertEquals(bareUnitOf([[-122.756, 48.995], [-122.756, 49.005]]), 'none');
  assertEquals(bareUnitOf([[13.4, 52.5], [13.41, 52.51]]), 'kmh');
  // Detroit lies in the strip the boxes leave along the river: a street wholly in it reads km/h,
  // and one running out to Westland, inside a box, gives no limit from a bare number.
  assertEquals(bareUnitOf([[-83.0458, 42.3314], [-83.05, 42.335]]), 'kmh');
  assertEquals(bareUnitOf([[-83.0458, 42.3314], [-83.4, 42.32]]), 'none');
  assertEquals(bareUnitOf([[-66.11, 18.46], [-66.1, 18.47]]), 'mph'); // San Juan
});
