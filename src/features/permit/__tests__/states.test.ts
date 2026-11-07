/**
 * The state table pinned row by row against the research table (`.agent/round15/gdl-table.md`,
 * copied verbatim below): code, name, total hours, night hours, night rule and note. And the
 * lookups: by postal code, and from a geocoder's region (an iPhone's code or Android's full name).
 */
import { NIGHT_RULES, PERMIT_STATES, stateByCode, stateFromRegion, STATES_BY_NAME } from '../states';

const TABLE = `
| AL | Alabama | 50 | null | sunset | Not needed if you pass a state-approved driver's ed course. |
| AK | Alaska | 40 | null | sunset | 10 of the 40 hours must be in challenging conditions, like bad weather or darkness. |
| AZ | Arizona | 30 | 10 | sunset | Not needed after an ADOT-approved driver's ed program. Some other courses lower it to 20 hours (6 at night). |
| AR | Arkansas | null | null | sunset | Arkansas doesn't set a minimum number of practice hours. |
| CA | California | 50 | 10 | dark30 | |
| CO | Colorado | 50 | 10 | sunset | Under 16½ without a nearby driving school, 12 more hours with a parent are needed. |
| CT | Connecticut | 40 | null | sunset | Hours with a driving school can count toward the 40. |
| DC | District of Columbia | 40 | null | sunset | 10 hours of night driving are needed later, before the full license. |
| DE | Delaware | 50 | 10 | sunset | |
| FL | Florida | 50 | 10 | sunset | |
| GA | Georgia | 40 | 6 | sunset | |
| HI | Hawaii | 50 | 10 | sunset | |
| ID | Idaho | 50 | 10 | sunset | |
| IL | Illinois | 50 | 10 | sunset | |
| IN | Indiana | 50 | 10 | sunset | |
| IA | Iowa | 20 | 2 | sunset | |
| KS | Kansas | 50 | 10 | sunset | Licensed at 15: 25 hours before the license, then 25 more before 16. |
| KY | Kentucky | 60 | 10 | sunset | |
| LA | Louisiana | 50 | 15 | sunset | |
| ME | Maine | 70 | 10 | dark30 | |
| MD | Maryland | 60 | 10 | md30 | |
| MA | Massachusetts | 40 | null | sunset | 30 hours if you finish a driver skills development program. |
| MI | Michigan | 50 | 10 | dark30 | At least 30 hours (2 at night) are needed before Segment 2. |
| MN | Minnesota | 50 | 15 | sunset | 40 hours (15 at night) if your parent takes the supplemental parent class. |
| MS | Mississippi | 50 | null | sunset | Needed only if you apply before 17. |
| MO | Missouri | 40 | 10 | sunset | Hours with a certified driving instructor can count. |
| MT | Montana | 50 | 10 | sunset | The alternative traffic ed course needs 75 hours (15 at night). |
| NE | Nebraska | 50 | 10 | sunset | Not needed if you pass a DMV-approved driver safety course. |
| NV | Nevada | 50 | 10 | sunset | 100 hours (10 at night) if no driver's ed course is available near you. |
| NH | New Hampshire | 40 | 10 | dark30 | |
| NJ | New Jersey | 50 | 10 | sunset | For permits issued on or after February 1, 2025. |
| NM | New Mexico | 50 | 10 | sunset | |
| NY | New York | 50 | 15 | sunset | Supervised hours in a driver's ed course count toward the 50. |
| NC | North Carolina | 60 | 10 | sunset | No more than 10 hours a week count. |
| ND | North Dakota | 50 | null | sunset | Needed only if you're under 16. The hours must include some night driving. |
| OH | Ohio | 50 | 10 | dark30 | |
| OK | Oklahoma | 50 | 10 | sunset | |
| OR | Oregon | 100 | null | sunset | 50 hours if you pass an ODOT-approved driver's ed course. |
| PA | Pennsylvania | 65 | 10 | sunset | 5 of the hours must be in bad weather. |
| RI | Rhode Island | 50 | 10 | sunset | Lessons with a driving school can count. |
| SC | South Carolina | 40 | 10 | sunset | |
| SD | South Dakota | 50 | 10 | sunset | 10 of the hours must be in bad weather. |
| TN | Tennessee | 50 | 10 | sunset | |
| TX | Texas | 30 | 10 | sunset | |
| UT | Utah | 40 | 10 | sunset | Driver's ed hours, and up to 5 hours of simulator practice, can count. |
| VT | Vermont | 40 | 10 | dark30 | |
| VA | Virginia | 45 | 15 | sunset | |
| WA | Washington | 50 | 10 | sunset | |
| WV | West Virginia | 50 | 10 | sunset | Not needed if you pass a state-approved driver's ed course. |
| WI | Wisconsin | 50 | 10 | dark30 | Each hour with a driving instructor counts as 2, up to 5 instructor hours. |
| WY | Wyoming | 50 | 10 | sunset | |
`;

/** The research table's rows, parsed: `null` is no minimum, an empty note is none. */
const EXPECTED = TABLE.trim()
  .split('\n')
  .map((line) => {
    const [code, name, totalH, nightH, nightRule, note] = line.split('|').slice(1, -1).map((c) => c.trim());
    const num = (v: string | undefined) => (v === 'null' ? null : Number(v));
    return { code, name, totalH: num(totalH), nightH: num(nightH), nightRule, note };
  });

test('the table has the 50 states and DC, once each, in the research order', () => {
  expect(EXPECTED).toHaveLength(51);
  expect(PERMIT_STATES).toHaveLength(51);
  expect(new Set(PERMIT_STATES.map((s) => s.code)).size).toBe(51);
  expect(PERMIT_STATES.map((s) => s.code)).toEqual(EXPECTED.map((s) => s.code));
});

test.each(EXPECTED)('$code: $name, $totalH h ($nightH at night), $nightRule, its note', (row) => {
  expect(stateByCode(row.code)).toEqual(row);
});

test('every night rule is one the app knows, and every note is plain', () => {
  for (const s of PERMIT_STATES) {
    expect(NIGHT_RULES).toContain(s.nightRule);
    expect(s.note).not.toMatch(/[–—!’]/);
  }
  expect(PERMIT_STATES.filter((s) => s.nightRule === 'dark30').map((s) => s.code)).toEqual(['CA', 'ME', 'MI', 'NH', 'OH', 'VT', 'WI']);
  expect(PERMIT_STATES.filter((s) => s.nightRule === 'md30').map((s) => s.code)).toEqual(['MD']);
});

test('a postal code in any case finds its state; anything else none', () => {
  expect(stateByCode('wa')?.name).toBe('Washington');
  expect(stateByCode(' DC ')?.name).toBe('District of Columbia');
  expect(stateByCode('PR')).toBeNull();
  expect(stateByCode(null)).toBeNull();
  expect(stateByCode(42)).toBeNull();
});

test("a geocoder's region: an iPhone's code or Android's full name, DC in its spellings", () => {
  expect(stateFromRegion('CA')?.code).toBe('CA');
  expect(stateFromRegion('California')?.code).toBe('CA');
  expect(stateFromRegion('new york')?.code).toBe('NY');
  expect(stateFromRegion('Washington')?.code).toBe('WA');
  expect(stateFromRegion('District of Columbia')?.code).toBe('DC');
  expect(stateFromRegion('Washington, D.C.')?.code).toBe('DC');
  expect(stateFromRegion('Washington DC')?.code).toBe('DC');
  expect(stateFromRegion('Ontario')).toBeNull();
  expect(stateFromRegion('')).toBeNull();
  expect(stateFromRegion(undefined)).toBeNull();
});

test('the picker lists them A to Z by name', () => {
  const names = STATES_BY_NAME.map((s) => s.name);
  expect(names[0]).toBe('Alabama');
  expect(names.indexOf('Delaware')).toBeLessThan(names.indexOf('District of Columbia'));
  expect(names[50]).toBe('Wyoming');
  expect(names).toHaveLength(51);
});
