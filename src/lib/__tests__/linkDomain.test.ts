import { asLinkDomain } from '../linkDomain';

test('a bare host name, lower-cased; anything else is no domain', () => {
  expect(asLinkDomain('roadwise.app')).toBe('roadwise.app');
  expect(asLinkDomain(' RoadWise.App ')).toBe('roadwise.app');
  expect(asLinkDomain('links.road-wise.co.uk')).toBe('links.road-wise.co.uk');
  for (const bad of ['', 'roadwise', 'https://roadwise.app', 'roadwise.app/w', 'roadwise.app:443', 'road wise.app', '-x.app', 'x..app', 42, null, undefined]) {
    expect(asLinkDomain(bad)).toBeNull();
  }
});
