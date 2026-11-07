/**
 * The US states' practice-hour rules for a learner's permit (50 states and DC): the supervised
 * hours a state asks for before the license (`totalH`; null when it sets no minimum), the night
 * hours among them (`nightH`; null when it sets none), what counts as night there (`nightRule`) and
 * a short note shown under the hour targets (empty when none). Researched from each state's DMV
 * pages, log forms and statutes; the driver can change the targets, and the screen asks them to
 * check these against their state's current rules. Pure data.
 */

/**
 * What counts as night: `sunset` from sunset to sunrise; `dark30` from 30 minutes after sunset to
 * 30 minutes before sunrise; `md30` from 30 minutes before sunset to 30 minutes after sunrise. A
 * state whose rules don't define night uses `sunset`.
 */
export type NightRule = 'sunset' | 'dark30' | 'md30';
export const NIGHT_RULES: readonly NightRule[] = ['sunset', 'dark30', 'md30'];

export interface PermitState {
  /** The two-letter postal code ("CA"). */
  code: string;
  name: string;
  /** Supervised hours needed; null: the state sets no minimum. */
  totalH: number | null;
  /** Night hours among them; null: no night minimum. */
  nightH: number | null;
  nightRule: NightRule;
  /** Shown under the targets; empty: none. */
  note: string;
}

/** Every state and DC, in the research table's order. */
export const PERMIT_STATES: readonly PermitState[] = Object.freeze([
  { code: 'AL', name: 'Alabama', totalH: 50, nightH: null, nightRule: 'sunset', note: "Not needed if you pass a state-approved driver's ed course." },
  { code: 'AK', name: 'Alaska', totalH: 40, nightH: null, nightRule: 'sunset', note: '10 of the 40 hours must be in challenging conditions, like bad weather or darkness.' },
  { code: 'AZ', name: 'Arizona', totalH: 30, nightH: 10, nightRule: 'sunset', note: "Not needed after an ADOT-approved driver's ed program. Some other courses lower it to 20 hours (6 at night)." },
  { code: 'AR', name: 'Arkansas', totalH: null, nightH: null, nightRule: 'sunset', note: "Arkansas doesn't set a minimum number of practice hours." },
  { code: 'CA', name: 'California', totalH: 50, nightH: 10, nightRule: 'dark30', note: '' },
  { code: 'CO', name: 'Colorado', totalH: 50, nightH: 10, nightRule: 'sunset', note: 'Under 16½ without a nearby driving school, 12 more hours with a parent are needed.' },
  { code: 'CT', name: 'Connecticut', totalH: 40, nightH: null, nightRule: 'sunset', note: 'Hours with a driving school can count toward the 40.' },
  { code: 'DC', name: 'District of Columbia', totalH: 40, nightH: null, nightRule: 'sunset', note: '10 hours of night driving are needed later, before the full license.' },
  { code: 'DE', name: 'Delaware', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'FL', name: 'Florida', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'GA', name: 'Georgia', totalH: 40, nightH: 6, nightRule: 'sunset', note: '' },
  { code: 'HI', name: 'Hawaii', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'ID', name: 'Idaho', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'IL', name: 'Illinois', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'IN', name: 'Indiana', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'IA', name: 'Iowa', totalH: 20, nightH: 2, nightRule: 'sunset', note: '' },
  { code: 'KS', name: 'Kansas', totalH: 50, nightH: 10, nightRule: 'sunset', note: 'Licensed at 15: 25 hours before the license, then 25 more before 16.' },
  { code: 'KY', name: 'Kentucky', totalH: 60, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'LA', name: 'Louisiana', totalH: 50, nightH: 15, nightRule: 'sunset', note: '' },
  { code: 'ME', name: 'Maine', totalH: 70, nightH: 10, nightRule: 'dark30', note: '' },
  { code: 'MD', name: 'Maryland', totalH: 60, nightH: 10, nightRule: 'md30', note: '' },
  { code: 'MA', name: 'Massachusetts', totalH: 40, nightH: null, nightRule: 'sunset', note: '30 hours if you finish a driver skills development program.' },
  { code: 'MI', name: 'Michigan', totalH: 50, nightH: 10, nightRule: 'dark30', note: 'At least 30 hours (2 at night) are needed before Segment 2.' },
  { code: 'MN', name: 'Minnesota', totalH: 50, nightH: 15, nightRule: 'sunset', note: '40 hours (15 at night) if your parent takes the supplemental parent class.' },
  { code: 'MS', name: 'Mississippi', totalH: 50, nightH: null, nightRule: 'sunset', note: 'Needed only if you apply before 17.' },
  { code: 'MO', name: 'Missouri', totalH: 40, nightH: 10, nightRule: 'sunset', note: 'Hours with a certified driving instructor can count.' },
  { code: 'MT', name: 'Montana', totalH: 50, nightH: 10, nightRule: 'sunset', note: 'The alternative traffic ed course needs 75 hours (15 at night).' },
  { code: 'NE', name: 'Nebraska', totalH: 50, nightH: 10, nightRule: 'sunset', note: 'Not needed if you pass a DMV-approved driver safety course.' },
  { code: 'NV', name: 'Nevada', totalH: 50, nightH: 10, nightRule: 'sunset', note: "100 hours (10 at night) if no driver's ed course is available near you." },
  { code: 'NH', name: 'New Hampshire', totalH: 40, nightH: 10, nightRule: 'dark30', note: '' },
  { code: 'NJ', name: 'New Jersey', totalH: 50, nightH: 10, nightRule: 'sunset', note: 'For permits issued on or after February 1, 2025.' },
  { code: 'NM', name: 'New Mexico', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'NY', name: 'New York', totalH: 50, nightH: 15, nightRule: 'sunset', note: "Supervised hours in a driver's ed course count toward the 50." },
  { code: 'NC', name: 'North Carolina', totalH: 60, nightH: 10, nightRule: 'sunset', note: 'No more than 10 hours a week count.' },
  { code: 'ND', name: 'North Dakota', totalH: 50, nightH: null, nightRule: 'sunset', note: "Needed only if you're under 16. The hours must include some night driving." },
  { code: 'OH', name: 'Ohio', totalH: 50, nightH: 10, nightRule: 'dark30', note: '' },
  { code: 'OK', name: 'Oklahoma', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'OR', name: 'Oregon', totalH: 100, nightH: null, nightRule: 'sunset', note: "50 hours if you pass an ODOT-approved driver's ed course." },
  { code: 'PA', name: 'Pennsylvania', totalH: 65, nightH: 10, nightRule: 'sunset', note: '5 of the hours must be in bad weather.' },
  { code: 'RI', name: 'Rhode Island', totalH: 50, nightH: 10, nightRule: 'sunset', note: 'Lessons with a driving school can count.' },
  { code: 'SC', name: 'South Carolina', totalH: 40, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'SD', name: 'South Dakota', totalH: 50, nightH: 10, nightRule: 'sunset', note: '10 of the hours must be in bad weather.' },
  { code: 'TN', name: 'Tennessee', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'TX', name: 'Texas', totalH: 30, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'UT', name: 'Utah', totalH: 40, nightH: 10, nightRule: 'sunset', note: "Driver's ed hours, and up to 5 hours of simulator practice, can count." },
  { code: 'VT', name: 'Vermont', totalH: 40, nightH: 10, nightRule: 'dark30', note: '' },
  { code: 'VA', name: 'Virginia', totalH: 45, nightH: 15, nightRule: 'sunset', note: '' },
  { code: 'WA', name: 'Washington', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
  { code: 'WV', name: 'West Virginia', totalH: 50, nightH: 10, nightRule: 'sunset', note: "Not needed if you pass a state-approved driver's ed course." },
  { code: 'WI', name: 'Wisconsin', totalH: 50, nightH: 10, nightRule: 'dark30', note: 'Each hour with a driving instructor counts as 2, up to 5 instructor hours.' },
  { code: 'WY', name: 'Wyoming', totalH: 50, nightH: 10, nightRule: 'sunset', note: '' },
]);

const BY_CODE = new Map(PERMIT_STATES.map((s) => [s.code, s]));
const BY_NAME = new Map(PERMIT_STATES.map((s) => [s.name.toLowerCase(), s]));

/**
 * The Spanish names that differ from the English ones, accents left off: Android's geocoder names
 * the state in the phone's language, and Spanish is the common non-English one in the US.
 */
const SPANISH_NAMES: Readonly<Record<string, string>> = {
  'carolina del norte': 'NC',
  'carolina del sur': 'SC',
  'dakota del norte': 'ND',
  'dakota del sur': 'SD',
  'distrito de columbia': 'DC',
  hawai: 'HI',
  luisiana: 'LA',
  misisipi: 'MS',
  misuri: 'MO',
  'nueva hampshire': 'NH',
  'nuevo hampshire': 'NH',
  'nueva jersey': 'NJ',
  'nueva york': 'NY',
  'nuevo mexico': 'NM',
  pensilvania: 'PA',
  tenesi: 'TN',
  'virginia occidental': 'WV',
};

/** Lower case, accents off ("Nuevo México" → "nuevo mexico"), no dots, single spaces. */
function plainName(s: string): string {
  let n = s.toLowerCase();
  try {
    n = n.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // No normalizer on this engine: accented names stay as they are.
  }
  return n.replace(/\./g, '').replace(/\s+/g, ' ');
}

/** The state with this postal code (any case); null for anything else. */
export function stateByCode(code: unknown): PermitState | null {
  if (typeof code !== 'string') return null;
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

/**
 * The state a geocoder's region names: a postal code ("WA", as an iPhone says it) or a full name
 * ("Washington", as Android says it; "Washington, D.C." and "Washington DC" too), in English or,
 * on a phone set to Spanish, in Spanish ("Nueva York"). Null otherwise.
 */
export function stateFromRegion(region: unknown): PermitState | null {
  if (typeof region !== 'string') return null;
  const r = region.trim();
  if (r.length === 2) return stateByCode(r);
  const name = plainName(r);
  if (name === 'washington dc' || name === 'washington, dc' || name === 'dc') return stateByCode('DC');
  return BY_NAME.get(name) ?? stateByCode(SPANISH_NAMES[name]);
}

/** Every state, A to Z by name (the picker's order). */
export const STATES_BY_NAME: readonly PermitState[] = Object.freeze([...PERMIT_STATES].sort((a, b) => a.name.localeCompare(b.name, 'en-US')));
