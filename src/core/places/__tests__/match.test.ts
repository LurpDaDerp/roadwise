import {
  addressParts,
  addressUnknown,
  ANCHOR_MIN_ENDS,
  ANCHOR_NEAR_M,
  matchPlace,
  normalizeNumber,
  normalizeStreet,
  parseAddressLine,
  PLACE_ADDRESS_MAX_M,
  PLACE_ANCHOR_M,
  PLACE_NAMED_M,
  PLACE_SURE_M,
  placeAnchor,
  placeAnchors,
  RANGE_MAX_SPAN,
  sameAddress,
  sameNumber,
  type MatchablePlace,
} from '@/core/places/match';
import { haversineMeters, type LatLng } from '@/lib/geo';

const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
/** A point `east` m east and `north` m north of the origin. */
const at = (east: number, north = 0): LatLng => ({ lat: LAT + north / M_PER_DEG_LAT, lng: LNG + east / M_PER_DEG_LNG });

type P = MatchablePlace & { name: string };
const home: P = { id: 'home', name: 'Home', address: '123 Main St', ...at(0) };
const school: P = { id: 'school', name: 'School', address: 'Roosevelt High School', ...at(1000) };

describe('address lines and parts', () => {
  test('a leading house number then the street; anything after a comma is not the street', () => {
    expect(parseAddressLine('123 Main St')).toEqual({ number: '123', street: 'Main St' });
    expect(parseAddressLine('  12B Baker Street ')).toEqual({ number: '12B', street: 'Baker Street' });
    expect(parseAddressLine('120-124 Main St')).toEqual({ number: '120-124', street: 'Main St' });
    expect(parseAddressLine('120–124 Main St')).toEqual({ number: '120–124', street: 'Main St' });
    expect(parseAddressLine('123 Main St, Seattle WA')).toEqual({ number: '123', street: 'Main St' });
  });

  test('a line that does not start with a house number (a named place) has neither', () => {
    for (const line of ['Roosevelt High School', '1st Avenue', '', 'Main St 12', '123', '123,Main']) {
      expect(parseAddressLine(line)).toEqual({ number: null, street: null });
    }
    expect(parseAddressLine(null)).toEqual({ number: null, street: null });
    expect(parseAddressLine(undefined)).toEqual({ number: null, street: null });
  });

  test('stored parts win; a place saved before them reads its address line', () => {
    expect(addressParts({ address: '123 Main St' })).toEqual({ number: '123', street: 'Main St' });
    expect(addressParts({ address: '123 Main St', number: '125', street: 'Main Street' })).toEqual({ number: '125', street: 'Main Street' });
    // A named place saved with its source's parts: no number, its street kept.
    expect(addressParts({ address: 'Roosevelt High School', number: null, street: 'NE 66th St' })).toEqual({ number: null, street: 'NE 66th St' });
    // One part stored is enough to trust the stored parts (the other is none).
    expect(addressParts({ address: '123 Main St', number: null })).toEqual({ number: null, street: null });
    expect(addressParts({ address: '123 Main St', number: ' ', street: '' })).toEqual({ number: null, street: null });
  });
});

describe('normalising', () => {
  test('house numbers: lowercase, no spaces, any dash a hyphen', () => {
    expect(normalizeNumber(' 12 B ')).toBe('12b');
    expect(normalizeNumber('120–124')).toBe('120-124');
  });

  test('street names: case, punctuation, accents and the usual words', () => {
    expect(normalizeStreet('North Main Street')).toBe('n main st');
    expect(normalizeStreet('N. Main St.')).toBe('n main st');
    expect(normalizeStreet('NE 66th St')).toBe(normalizeStreet('Northeast 66th Street'));
    expect(normalizeStreet('First Avenue South')).toBe('1st ave s');
    expect(normalizeStreet('Tenth  Avenue')).toBe('10th ave');
    expect(normalizeStreet("O'Neil Drive")).toBe('oneil dr');
    expect(normalizeStreet('Martin Luther King Jr. Way')).toBe('martin luther king jr way');
    expect(normalizeStreet('Avenue Road')).toBe('ave rd');
    expect(normalizeStreet('Rue Saint-Honoré')).toBe('rue saint honore');
    for (const [long, short] of [
      ['Boulevard', 'blvd'], ['Lane', 'ln'], ['Court', 'ct'], ['Place', 'pl'], ['Terrace', 'ter'], ['Parkway', 'pkwy'], ['Highway', 'hwy'],
      ['Circle', 'cir'], ['Square', 'sq'], ['Trail', 'trl'], ['Southwest', 'sw'], ['Southeast', 'se'], ['Northwest', 'nw'], ['West', 'w'], ['East', 'e'],
      ['Second', '2nd'], ['Third', '3rd'], ['Fourth', '4th'], ['Fifth', '5th'], ['Sixth', '6th'], ['Seventh', '7th'], ['Eighth', '8th'], ['Ninth', '9th'],
    ]) {
      expect(normalizeStreet(long as string)).toBe(short);
    }
  });

  test('a word that is also an object key is just a word', () => {
    expect(normalizeStreet('Constructor Way')).toBe('constructor way');
    expect(normalizeStreet('toString __proto__ Rd')).toBe('tostring proto rd');
  });
});

describe('the same address', () => {
  test('the same number and street after normalising', () => {
    expect(sameAddress({ number: '123', street: 'Main Street' }, { number: '123', street: 'Main St' })).toBe(true);
    expect(sameAddress({ number: '12B', street: 'Baker St' }, { number: '12b', street: 'baker street' })).toBe(true);
    expect(sameAddress({ number: '0123', street: 'Main St' }, { number: '123', street: 'Main St' })).toBe(true);
  });

  test('a different number, a different street, or a part missing on either side is not', () => {
    expect(sameAddress({ number: '123', street: 'Main St' }, { number: '125', street: 'Main St' })).toBe(false);
    expect(sameAddress({ number: '123', street: 'Main St' }, { number: '123', street: 'Oak St' })).toBe(false);
    expect(sameAddress({ number: '123', street: 'N Main St' }, { number: '123', street: 'S Main St' })).toBe(false);
    expect(sameAddress({ number: '12', street: 'Baker St' }, { number: '12b', street: 'Baker St' })).toBe(false);
    expect(sameAddress({ number: '123', street: null }, { number: '123', street: 'Main St' })).toBe(false);
    expect(sameAddress({ number: null, street: 'Main St' }, { number: null, street: 'Main St' })).toBe(false);
    expect(sameAddress({ number: '123', street: '...' }, { number: '123', street: '!!' })).toBe(false);
  });

  test('a range holds every number on its side of the street in it; two hyphenated numbers match only when equal', () => {
    expect(sameNumber('120-124', '122')).toBe(true);
    expect(sameNumber('122', '120–124')).toBe(true);
    expect(sameNumber('120-124', '120')).toBe(true);
    expect(sameNumber('120-124', '124')).toBe(true);
    expect(sameNumber('120-124', '126')).toBe(false);
    // The other side of the street is not in the range.
    expect(sameNumber('120-124', '121')).toBe(false);
    expect(sameNumber('120-128', '122-124')).toBe(false);
    expect(sameNumber('120-124', '124-128')).toBe(false);
    expect(sameNumber('120-124', '120-124')).toBe(true);
    expect(sameNumber('120-124', '122a')).toBe(false);
    expect(sameNumber(`100-${100 + RANGE_MAX_SPAN}`, '110')).toBe(true);
    expect(sameNumber(`100-${100 + RANGE_MAX_SPAN + 2}`, '110')).toBe(false);
  });

  test('Queens and Hawaii numbers (block then lot) are each only themselves', () => {
    expect(sameNumber('37-12', '37-12')).toBe(true);
    expect(sameNumber('37-12', '20')).toBe(false);
    expect(sameNumber('37-40', '37-48')).toBe(false);
    expect(sameNumber('37-48', '37-40')).toBe(false);
    expect(sameNumber('37-40', '38')).toBe(false);
    expect(sameNumber('94-1234', '94-1240')).toBe(false);
    expect(sameNumber('94-1234', '500')).toBe(false);
    expect(sameNumber('94-1234', '94–1234')).toBe(true);
    expect(sameNumber('', '')).toBe(false);
  });

  test('neighbours on a Queens or Hawaii block are not the same address', () => {
    expect(sameAddress({ number: '37-40', street: '82nd St' }, { number: '37-48', street: '82nd St' })).toBe(false);
    expect(sameAddress({ number: '94-1234', street: 'Kahuailani St' }, { number: '94-1240', street: 'Kahuailani St' })).toBe(false);
    const queens: P = { id: 'home', name: 'Home', address: '37-40 82nd St', ...at(0) };
    expect(matchPlace(at(60), [queens], { address: { number: '37-48', street: '82nd Street' } })).toBeNull();
    expect(matchPlace(at(60), [queens], { address: { number: '37-40', street: '82nd Street' } })).toBe(queens);
  });
});

describe('matchPlace', () => {
  test('rule 1: within 20 m of the place', () => {
    expect(matchPlace(at(PLACE_SURE_M - 1), [home])).toBe(home);
    expect(matchPlace(at(0, -(PLACE_SURE_M - 1)), [home])).toBe(home);
    expect(matchPlace(at(PLACE_SURE_M + 1), [home])).toBeNull();
  });

  test('rule 2: within 12 m of where the driver usually parks there', () => {
    const anchors = new Map([['home', at(35)]]);
    expect(matchPlace(at(35 + PLACE_ANCHOR_M - 1), [home], { anchors })).toBe(home);
    expect(matchPlace(at(35 - PLACE_ANCHOR_M + 1), [home], { anchors })).toBe(home);
    expect(matchPlace(at(35 + PLACE_ANCHOR_M + 1), [home], { anchors })).toBeNull();
    // Another place's anchor is not Home's.
    expect(matchPlace(at(35), [home], { anchors: new Map([['work', at(35)]]) })).toBeNull();
  });

  test('rule 3: the same number and street within 150 m', () => {
    const same = { number: '123', street: 'Main Street' };
    expect(matchPlace(at(60), [home], { address: same })).toBe(home);
    expect(matchPlace(at(PLACE_ADDRESS_MAX_M - 1), [home], { address: same })).toBe(home);
    expect(matchPlace(at(PLACE_ADDRESS_MAX_M + 1), [home], { address: same })).toBeNull();
  });

  test('a neighbour a few doors down: a different number, no number, or no geocode is not Home', () => {
    expect(matchPlace(at(40), [home], { address: { number: '127', street: 'Main St' } })).toBeNull();
    expect(matchPlace(at(40), [home], { address: { number: null, street: 'Main St' } })).toBeNull();
    expect(matchPlace(at(40), [home], { address: { number: '123', street: 'Oak St' } })).toBeNull();
    expect(matchPlace(at(40), [home], { address: null })).toBeNull();
    expect(matchPlace(at(40), [home])).toBeNull();
    // …though a different geocoded number never undoes a sure match (rules 1 and 2).
    expect(matchPlace(at(10), [home], { address: { number: '127', street: 'Main St' } })).toBe(home);
    expect(matchPlace(at(40), [home], { address: { number: '127', street: 'Main St' }, anchors: new Map([['home', at(40)]]) })).toBe(home);
  });

  test('rule 4: a named place (no house number) within 100 m, whatever the geocoder says', () => {
    expect(matchPlace(at(1000 + PLACE_NAMED_M - 1), [school])).toBe(school);
    expect(matchPlace(at(1000 + PLACE_NAMED_M - 1), [school], { address: { number: '1410', street: 'NE 66th St' } })).toBe(school);
    expect(matchPlace(at(1000 + PLACE_NAMED_M + 1), [school])).toBeNull();
    // A place saved with no number in its stored parts is a named place too.
    const store: P = { id: 'place-1', name: 'Store', address: 'Fred Meyer', number: null, street: 'Stone Way N', ...at(-500) };
    expect(matchPlace(at(-570), [store])).toBe(store);
  });

  test('a place whose address could not be looked up is no named place: rules 1 and 2 only', () => {
    // Home saved by "Use my current location" while offline: no number, a stand-in address.
    const offline: P = { id: 'home', name: 'Home', address: 'Address not found', number: null, street: null, unknownAddress: true, ...at(0) };
    expect(matchPlace(at(60), [offline])).toBeNull();
    expect(matchPlace(at(60), [offline], { address: { number: '127', street: 'Main St' } })).toBeNull();
    expect(matchPlace(at(PLACE_SURE_M - 1), [offline])).toBe(offline);
    expect(matchPlace(at(60), [offline], { anchors: new Map([['home', at(58)]]) })).toBe(offline);
    // Saved before the flag was kept: the stand-in lines read as unknown too.
    for (const address of ['Address not found', 'Saved from a drive', 'Inside your “Home” zone', '']) {
      expect(matchPlace(at(60), [{ id: 'home', name: 'Home', address, ...at(0) }])).toBeNull();
    }
  });

  test('addressUnknown: the flag, or a stand-in line', () => {
    expect(addressUnknown({ address: 'Roosevelt High School' })).toBe(false);
    expect(addressUnknown({ address: '123 Main St' })).toBe(false);
    expect(addressUnknown({ address: 'Somewhere', unknownAddress: true })).toBe(true);
    expect(addressUnknown({ address: ' address not found ' })).toBe(true);
    expect(addressUnknown({ address: 'Saved from a drive' })).toBe(true);
    expect(addressUnknown({ address: 'Inside your “Grandma’s” zone' })).toBe(true);
    expect(addressUnknown({ address: 'In your “Home” zone' })).toBe(true);
    expect(addressUnknown({})).toBe(true);
  });

  test('sureOnly: rules 1 and 2 only', () => {
    expect(matchPlace(at(60), [home], { address: { number: '123', street: 'Main St' }, sureOnly: true })).toBeNull();
    expect(matchPlace(at(1050), [school], { sureOnly: true })).toBeNull();
    expect(matchPlace(at(1010), [school], { sureOnly: true })).toBe(school);
  });

  test('several: a sure match first, then the nearest', () => {
    const shop: P = { id: 'place-2', name: 'Shop', address: 'Corner Shop', ...at(60) };
    // 18 m from Home (sure), 42 m from the shop (by name): Home.
    expect(matchPlace(at(18), [shop, home])).toBe(home);
    // 25 m from Home (no match without an address), 35 m from the shop: the shop.
    expect(matchPlace(at(25), [shop, home])).toBe(shop);
    // With Home's address both match by address or name: the nearer wins.
    expect(matchPlace(at(25), [shop, home], { address: { number: '123', street: 'Main St' } })).toBe(home);
    expect(matchPlace(at(35), [shop, home], { address: { number: '123', street: 'Main St' } })).toBe(shop);
    expect(matchPlace(at(-5), [shop, { ...home, ...at(-25) }, home])).toBe(home);
    // Two sure matches: the nearer.
    const next: P = { id: 'place-3', name: 'Next', address: '125 Main St', ...at(15) };
    expect(matchPlace(at(10), [home, next])).toBe(next);
    expect(matchPlace(at(5), [next, home])).toBe(home);
  });

  test('nothing for no point, a broken point or a broken place', () => {
    expect(matchPlace(null, [home])).toBeNull();
    expect(matchPlace({ lat: NaN, lng: LNG }, [home])).toBeNull();
    expect(matchPlace(at(0), [{ ...home, lat: NaN }])).toBeNull();
    expect(matchPlace(at(0), [])).toBeNull();
  });
});

describe('placeAnchor', () => {
  /** `n` ends around `center` (east m), each within `spread` m of it. */
  const ends = (center: number, n: number, spread = 2): LatLng[] => Array.from({ length: n }, (_, i) => at(center + ((i % 3) - 1) * spread, ((i % 2) - 0.5) * spread));

  test(`at least ${ANCHOR_MIN_ENDS} ends within 40 m, their median, with 75 % of them within 12 m of it`, () => {
    expect(placeAnchor(home, ends(25, ANCHOR_MIN_ENDS - 1))).toBeNull();
    const anchor = placeAnchor(home, ends(25, ANCHOR_MIN_ENDS));
    expect(anchor).not.toBeNull();
    expect(haversineMeters(anchor!, at(25))).toBeLessThan(3);
  });

  test('ends past 40 m are not counted', () => {
    expect(placeAnchor(home, [...ends(25, 3), ...ends(ANCHOR_NEAR_M + 5, 5)])).toBeNull();
  });

  test('scattered ends (street parking up and down the block) make no anchor', () => {
    const scattered = [at(-35), at(-20), at(-5), at(10), at(25), at(38)];
    expect(placeAnchor(home, scattered)).toBeNull();
    // 3 of 4 together is 75 %: an anchor; 3 of 5 is not.
    expect(placeAnchor(home, [...ends(25, 3), at(-30)])).not.toBeNull();
    expect(placeAnchor(home, [...ends(25, 3), at(-30), at(-35)])).toBeNull();
  });

  test('a named place has none; places without one are left out of the map', () => {
    expect(placeAnchor({ ...school, ...at(0) }, ends(25, 6))).toBeNull();
    const map = placeAnchors([home, school], ends(25, 6));
    expect([...map.keys()]).toEqual(['home']);
  });

  test('a place whose address is unknown still learns where the driver parks', () => {
    const offline: MatchablePlace = { id: 'home', address: 'Address not found', number: null, street: null, unknownAddress: true, ...at(0) };
    expect(placeAnchor(offline, ends(25, 6))).not.toBeNull();
    expect(placeAnchor({ id: 'home', address: 'Saved from a drive', ...at(0) }, ends(25, 6))).not.toBeNull();
  });

  test('broken ends are ignored', () => {
    expect(placeAnchor(home, [...ends(25, 3), { lat: NaN, lng: NaN }])).toBeNull();
  });
});
