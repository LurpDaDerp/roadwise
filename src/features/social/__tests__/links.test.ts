import { addLink, parseAddLink, parseWrappedLink, profileHref, USERNAME_RE, WRAPPED_ARCHIVE_HREF, wrappedHref, wrappedLink, wrappedMonthHref } from '../links';

jest.mock('@/lib/linkDomain', () => ({ linkDomain: () => null }));

describe('the friend QR code', () => {
  it('holds roadwise://add/<username>', () => {
    expect(addLink('swift_fox')).toBe('roadwise://add/swift_fox');
    expect(addLink('Swift_Fox')).toBe('roadwise://add/swift_fox');
  });

  it.each([
    ['roadwise://add/swift_fox', 'swift_fox'],
    ['roadwise://add/Swift_Fox', 'swift_fox'],
    ['roadwise://add/abc', 'abc'],
    ['roadwise://add/a2345678901234567890', 'a2345678901234567890'],
    ['  roadwise://add/maya_16/  ', 'maya_16'],
  ])('reads %p as %p', (raw, name) => {
    expect(parseAddLink(raw)).toBe(name);
  });

  it.each([
    'https://roadwise.app/add/swift_fox',
    'roadwise://clan/ABCD2345',
    'roadwise://add/',
    'roadwise://add/ab',
    'roadwise://add/a23456789012345678901',
    'roadwise://add/swift-fox',
    'roadwise://add/swift_fox?then=/drive',
    'roadwise://add/swift_fox/extra',
    'roadwise://add/../settings',
    'otherapp://add/swift_fox',
    'swift_fox',
    '',
    42,
    null,
  ])('rejects %p', (raw) => {
    expect(parseAddLink(raw)).toBeNull();
  });

  it('opens the lower-cased profile route', () => {
    expect(profileHref('Swift_Fox')).toBe('/u/swift_fox');
    expect(USERNAME_RE.test('swift_fox')).toBe(true);
    expect(USERNAME_RE.test('Swift')).toBe(false);
  });
});

describe('a shared Wrapped link', () => {
  const ID = 'Ab3dEf7hJk9m';

  it('is roadwise://w/<id> until a link domain is set, then https://<domain>/w/<id>', () => {
    expect(wrappedLink(ID)).toBe('roadwise://w/Ab3dEf7hJk9m');
    expect(wrappedLink(ID, null)).toBe('roadwise://w/Ab3dEf7hJk9m');
    expect(wrappedLink(ID, 'roadwise.app')).toBe('https://roadwise.app/w/Ab3dEf7hJk9m');
  });

  it.each([
    ['roadwise://w/Ab3dEf7hJk9m', null, ID],
    ['roadwise:///w/Ab3dEf7hJk9m/', null, ID],
    ['https://roadwise.app/w/Ab3dEf7hJk9m', 'roadwise.app', ID],
    ['https://RoadWise.app/w/Ab3dEf7hJk9m', 'roadwise.app', ID],
    // A trailing slash, query or fragment (tracking parameters) is dropped.
    ['roadwise://w/Ab3dEf7hJk9m?x=1', null, ID],
    ['https://roadwise.app/w/Ab3dEf7hJk9m/?utm_source=ig&fbclid=abc', 'roadwise.app', ID],
    ['https://roadwise.app/w/Ab3dEf7hJk9m#top', 'roadwise.app', ID],
  ])('reads %p (domain %p) as the id', (raw, domain, id) => {
    expect(parseWrappedLink(raw, domain)).toBe(id);
  });

  it.each([
    ['https://roadwise.app/w/Ab3dEf7hJk9m', null],
    ['https://evil.test/w/Ab3dEf7hJk9m', 'roadwise.app'],
    ['http://roadwise.app/w/Ab3dEf7hJk9m', 'roadwise.app'],
    ['roadwise://w/short', null],
    ['roadwise://w/Ab3dEf7hJk9m/extra', null],
    ['roadwise://add/swift_fox', null],
    [42, null],
  ])('rejects %p (domain %p)', (raw, domain) => {
    expect(parseWrappedLink(raw, domain)).toBeNull();
  });

  it('opens /w/<id>; the archive is /wrapped and a month /wrapped/YYYY-MM', () => {
    expect(wrappedHref(ID)).toBe('/w/Ab3dEf7hJk9m');
    expect(WRAPPED_ARCHIVE_HREF).toBe('/wrapped');
    expect(wrappedMonthHref('2026-10')).toBe('/wrapped/2026-10');
  });
});
