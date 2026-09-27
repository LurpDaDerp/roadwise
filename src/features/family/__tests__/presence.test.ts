import { freshness, memberName, placeAt, presenceLine } from '../presence';
import { me, member, NOW, place } from '../__fixtures__/world';

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

describe('placeAt', () => {
  it('finds the place a location is inside, the nearest when two overlap', () => {
    const home = place({ id: '00000000-0000-4000-8000-0000000000d1', name: 'Home', lat: 47.6, lng: -122.3, radiusM: 150 });
    const park = place({ id: '00000000-0000-4000-8000-0000000000d2', name: 'Park', lat: 47.6008, lng: -122.3, radiusM: 500 });
    expect(placeAt({ lat: 47.6001, lng: -122.3 }, [park, home])?.name).toBe('Home');
    expect(placeAt({ lat: 47.604, lng: -122.3 }, [home, park])?.name).toBe('Park');
    expect(placeAt({ lat: 47.7, lng: -122.3 }, [home, park])).toBeNull();
  });
});

describe('freshness', () => {
  it('reads just now, minutes, then hours', () => {
    expect(freshness(at(0.5), NOW)).toBe('just now');
    expect(freshness(at(5), NOW)).toBe('5 min ago');
    expect(freshness(at(130), NOW)).toBe('2 h ago');
  });
});

describe('presenceLine', () => {
  it('a member who does not share says so, with no time', () => {
    expect(presenceLine(member({ sharing: false, location: null }), [], null, NOW)).toEqual({ where: 'Location sharing off', when: null });
  });

  it('sharing but nothing recent: no recent location', () => {
    expect(presenceLine(member({ location: null }), [], null, NOW).where).toBe('No recent location');
  });

  it('inside a place: at it; driving: driving; otherwise near the area, or a plain line', () => {
    const loc = { lat: 47.6, lng: -122.3, accuracyM: 10, driving: false, updatedAt: at(5) };
    expect(presenceLine(member({ location: loc }), [place()], 'Capitol Hill', NOW)).toEqual({ where: 'At Home', when: '5 min ago' });
    expect(presenceLine(member({ location: { ...loc, lat: 47.7, driving: true } }), [place()], 'Capitol Hill', NOW).where).toBe('Driving');
    expect(presenceLine(member({ location: { ...loc, lat: 47.7 } }), [place()], 'Capitol Hill', NOW).where).toBe('Near Capitol Hill');
    expect(presenceLine(member({ location: { ...loc, lat: 47.7 } }), [place()], null, NOW).where).toBe('Location shared');
  });
});

describe('memberName', () => {
  it('the caller is You; a blank name is a neutral word', () => {
    expect(memberName(me())).toBe('You');
    expect(memberName(member({ name: '  ' }))).toBe('Family member');
    expect(memberName(member({ name: ' Sam ' }))).toBe('Sam');
  });
});
