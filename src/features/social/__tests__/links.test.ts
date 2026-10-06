import { addLink, parseAddLink, profileHref, USERNAME_RE } from '../links';

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
