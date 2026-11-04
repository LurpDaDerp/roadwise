/** @jest-environment node */
import { endLabel, GEOCODE_TIMEOUT_MS, labelFor, MAX_LABEL_CHARS, nearLabel, type Geocoder, type LabelPlace } from '@/core/engine/labels';
import { parseZones, type PrivacyZone } from '@/core/engine/privacy';
import type { LatLng } from '@/lib/geo';

const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
const at = (east: number, north = 0): LatLng => ({ lat: LAT + north / M_PER_DEG_LAT, lng: LNG + east / M_PER_DEG_LNG });

const home: LabelPlace = { id: 'home', name: 'Home', address: '123 Main St', ...at(0) };
const school: LabelPlace = { id: 'school', name: 'School', address: 'Roosevelt High School', ...at(3000) };
const homeZone: PrivacyZone = { id: 'z1', name: 'Home', ...at(0), radiusM: 300, placeId: 'home' };
const ownZone: PrivacyZone = { id: 'z2', name: 'Gym', ...at(-3000), radiusM: 300 };

/** A geocoder that answers `answer` and counts its calls. */
function geocoder(answer: Awaited<ReturnType<Geocoder>>) {
  const calls: LatLng[] = [];
  const geocode: Geocoder = async (p) => {
    calls.push(p);
    return answer;
  };
  return { geocode, calls };
}

describe('endLabel inside a privacy zone (never geocoded)', () => {
  test('the house itself (20 m) is Home', async () => {
    const g = geocoder({ label: 'Wallingford', number: '123', street: 'Main St' });
    expect(await endLabel(at(12), [homeZone], [home], g.geocode)).toEqual({ label: 'Home', placeId: 'home' });
    expect(g.calls).toHaveLength(0);
  });

  test('a neighbour a few doors down is "Near Home", with no place', async () => {
    const g = geocoder({ label: 'Wallingford', number: '131', street: 'Main St' });
    expect(await endLabel(at(45), [homeZone], [home], g.geocode)).toEqual({ label: 'Near Home', placeId: null });
    expect(g.calls).toHaveLength(0);
  });

  test('where the driver usually parks (the anchor) is Home', async () => {
    const g = geocoder(null);
    const parked = { ...home, anchor: at(32) };
    expect(await endLabel(at(40), [homeZone], [parked], g.geocode)).toEqual({ label: 'Home', placeId: 'home' });
    expect(await endLabel(at(48), [homeZone], [parked], g.geocode)).toEqual({ label: 'Near Home', placeId: null });
    expect(g.calls).toHaveLength(0);
  });

  test('a named place inside a zone matches within 100 m; a zone of its own keeps its name', async () => {
    const gym: LabelPlace = { id: 'place-1', name: 'Gym', address: 'Downtown Fitness', ...at(-3000) };
    expect(await endLabel(at(-2930), [ownZone], [gym], null)).toEqual({ label: 'Gym', placeId: 'place-1' });
    expect(await endLabel(at(-2850), [ownZone], [gym], null)).toEqual({ label: 'Gym', placeId: null });
    expect(await endLabel(at(-2850), [ownZone], [], null)).toEqual({ label: 'Gym', placeId: null });
  });

  test('a zone made from a place reads "Near" even when the places could not be read', async () => {
    expect(await endLabel(at(5), [homeZone], [], null)).toEqual({ label: 'Near Home', placeId: null });
  });
});

describe('endLabel outside the zones', () => {
  test('a sure match needs no geocode', async () => {
    const g = geocoder({ label: 'Wallingford', number: '123', street: 'Main St' });
    expect(await endLabel(at(15), [], [home], g.geocode)).toEqual({ label: 'Home', placeId: 'home' });
    expect(await endLabel(at(80), [], [{ ...home, anchor: at(75) }], g.geocode)).toEqual({ label: 'Home', placeId: 'home' });
    expect(g.calls).toHaveLength(0);
  });

  test('the same geocoded address within 150 m is Home; one geocode', async () => {
    const g = geocoder({ label: 'Wallingford', number: '123', street: 'Main Street' });
    expect(await endLabel(at(60), [], [home], g.geocode)).toEqual({ label: 'Home', placeId: 'home' });
    expect(g.calls).toEqual([at(60)]);
  });

  test('a Home saved while its address could not be looked up is never a neighbour 60 m away', async () => {
    const offline: LabelPlace = { id: 'home', name: 'Home', address: 'Address not found', number: null, street: null, unknownAddress: true, ...at(0) };
    expect(await endLabel(at(60), [homeZone], [offline], null)).toEqual({ label: 'Near Home', placeId: null });
    expect(await endLabel(at(60), [], [offline], async () => ({ label: 'Wallingford', number: '131', street: 'Main St' }))).toEqual({ label: 'Wallingford', placeId: null });
    expect(await endLabel(at(10), [homeZone], [offline], null)).toEqual({ label: 'Home', placeId: 'home' });
  });

  test('a different number next door is the geocoder label, not Home', async () => {
    const g = geocoder({ label: 'Wallingford', number: '127', street: 'Main St' });
    expect(await endLabel(at(30), [], [home], g.geocode)).toEqual({ label: 'Wallingford', placeId: null });
    expect(g.calls).toHaveLength(1);
  });

  test('a geocoder that gives text only (or nothing, or fails) can only leave rules 1, 2 and 4', async () => {
    expect(await endLabel(at(60), [], [home], async () => 'Wallingford')).toEqual({ label: 'Wallingford', placeId: null });
    expect(await endLabel(at(60), [], [home], async () => null)).toEqual({ label: null, placeId: null });
    expect(await endLabel(at(60), [], [home], async () => Promise.reject(new Error('offline')))).toEqual({ label: null, placeId: null });
    expect(
      await endLabel(at(60), [], [home], () => {
        throw new Error('sync');
      })
    ).toEqual({ label: null, placeId: null });
    expect(await endLabel(at(3060), [], [school], async () => null)).toEqual({ label: 'School', placeId: 'school' });
    expect(await endLabel(at(3060), [], [school], null)).toEqual({ label: 'School', placeId: 'school' });
  });

  test('no place near: the geocoder label as before, clipped', async () => {
    const long = 'x'.repeat(MAX_LABEL_CHARS + 10);
    const out = await endLabel(at(900), [], [home], async () => ({ label: long, number: null, street: null }));
    expect(out.placeId).toBeNull();
    expect(out.label).toHaveLength(MAX_LABEL_CHARS);
    expect(await endLabel(at(900), [], [home], async () => ({ label: '', number: '1', street: 'A St' }))).toEqual({ label: null, placeId: null });
  });

  test('a geocode that never answers leaves the label empty after the timeout', async () => {
    jest.useFakeTimers();
    try {
      const pending = endLabel(at(60), [], [home], () => new Promise(() => {}));
      jest.advanceTimersByTime(GEOCODE_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ label: null, placeId: null });
    } finally {
      jest.useRealTimers();
    }
  });

  test('no point: nothing', async () => {
    expect(await endLabel(null, [homeZone], [home], async () => 'x')).toEqual({ label: null, placeId: null });
  });
});

describe('the zone and label helpers', () => {
  test('nearLabel', () => {
    expect(nearLabel('Home')).toBe('Near Home');
  });

  test('labelFor still reads a text geocoder and an address one alike (spot names)', async () => {
    expect(await labelFor(at(900), [], async () => 'Dexter Ave N')).toBe('Dexter Ave N');
    expect(await labelFor(at(900), [], async () => ({ label: 'Fremont', number: '1', street: 'A St' }))).toBe('Fremont');
    expect(await labelFor(at(5), [homeZone], async () => 'never')).toBe('Home');
    expect(await labelFor(at(900), [], null)).toBeNull();
  });

  test('parseZones keeps the place a zone was made from', () => {
    const [made, own] = parseZones([
      { id: 'a', name: 'Home', lat: LAT, lng: LNG, radiusM: 300, placeId: 'home' },
      { id: 'b', name: 'Gym', lat: LAT, lng: LNG, radiusM: 300, placeId: '' },
    ]);
    expect(made?.placeId).toBe('home');
    expect(own).not.toHaveProperty('placeId');
  });
});
