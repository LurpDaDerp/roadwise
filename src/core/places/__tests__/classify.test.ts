/** The recap's "Save as …?" bar: a strong record, or a place named for what it is, never a street. */
import { isSchoolName, isWorkName, promptFor } from '../classify';
import type { LearnedPlace } from '../learn';

const learned = (over: Partial<LearnedPlace>): LearnedPlace => ({
  id: 'p',
  center: { lat: 1, lng: 1 },
  kind: 'frequent',
  visits: 10,
  days: 8,
  nights: 0,
  nightsSeen: 20,
  weekdays: 0,
  share: 0.2,
  pHome: 0,
  pWork: 0,
  lastSeen: 0,
  ...over,
});

describe('names', () => {
  it.each(['Roosevelt High School', 'Lakeside Academy', 'University of Washington', 'Bellevue College', 'Sunrise Montessori', 'Garfield Elementary'])('%s is a school', (n) =>
    expect(isSchoolName(n)).toBe(true)
  );

  it.each(['123 School St', '9 College Ave', 'University Way NE', 'Academy Rd', 'Starbucks', '742 Evergreen Terrace'])('%s is not', (n) => expect(isSchoolName(n)).toBe(false));

  it('knows an office by its name, not by a street', () => {
    expect(isWorkName('Acme Corporate Office')).toBe(true);
    expect(isWorkName('Microsoft Headquarters')).toBe(true);
    expect(isWorkName('1 Office Park Dr')).toBe(false);
    expect(isWorkName('Office Depot')).toBe(false);
    expect(isWorkName('Main Street Post Office')).toBe(false);
  });
});

describe('promptFor', () => {
  it('asks Home only with a strong record of nights', () => {
    expect(promptFor(learned({ kind: 'home', pHome: 0.85, nights: 12 }), null)).toEqual({ kind: 'home', why: 'nights' });
    expect(promptFor(learned({ kind: 'home', pHome: 0.85, nights: 4 }), null)).toBeNull();
    expect(promptFor(learned({ kind: 'home', pHome: 0.5, nights: 12 }), null)).toBeNull();
  });

  it('asks Work for a strong weekday place, School when it is named like one', () => {
    const weekday = learned({ kind: 'work', pWork: 0.8, weekdays: 9 });
    expect(promptFor(weekday, null)).toEqual({ kind: 'work', why: 'weekdays' });
    expect(promptFor(weekday, 'Lincoln High School')).toEqual({ kind: 'school', why: 'weekdays' });
    expect(promptFor(learned({ kind: 'work', pWork: 0.8, weekdays: 3 }), null)).toBeNull();
  });

  it('asks from the name alone, but never for an ordinary or unknown place', () => {
    expect(promptFor(null, 'Garfield Elementary')).toEqual({ kind: 'school', why: 'name' });
    expect(promptFor(learned({}), 'Acme Corporate Office')).toEqual({ kind: 'work', why: 'name' });
    expect(promptFor(learned({ visits: 40 }), 'Starbucks')).toBeNull();
    expect(promptFor(null, null)).toBeNull();
  });
});
