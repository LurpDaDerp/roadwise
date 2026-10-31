/**
 * Whether a drive's start or end is surely Home, Work or School, for the recap's "Save as …?"
 * card. Only a high bar asks: a learned place with a strong record (`HOME_SURE`, `WORK_SURE`), or a
 * place whose own name says what it is ("Roosevelt High School", "Acme Corporate Office"). A street
 * that only shares the word ("College Ave", "School St") never counts.
 */
import type { LearnedPlace } from './learn';

export type PromptKind = 'home' | 'work' | 'school';
/** Why it asks: the nights there, the weekday stays there, or the place's name. */
export type PromptWhy = 'nights' | 'weekdays' | 'name';

export const HOME_SURE = { p: 0.6, nights: 5 } as const;
export const WORK_SURE = { p: 0.5, weekdays: 5 } as const;

const STREET = String.raw`(?!\s+(?:st|street|rd|road|ave|avenue|ln|lane|dr|drive|way|blvd|boulevard|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace|loop|trl|trail|sq|square)\b)`;
const SCHOOL = new RegExp(
  String.raw`\b(?:school|academy|university|college|campus|institute|elementary|kindergarten|preschool|pre-school|montessori|polytechnic|conservatory|seminary)\b${STREET}`,
  'i'
);
// Not "office" alone: Office Depot, the post office and a doctor's office are places you visit.
const WORK = new RegExp(String.raw`\b(?:offices|headquarters|hq|corporate|business (?:park|center|centre)|office park|tech park|industrial park|corporate campus)\b${STREET}`, 'i');

/** The place's name says it's a school ("Lincoln High School"), not a street named for one. */
export const isSchoolName = (name: string): boolean => SCHOOL.test(name);
/** The place's name says it's a workplace ("Acme Corporate Office"). */
export const isWorkName = (name: string): boolean => WORK.test(name);

/**
 * What to ask about a drive end that is `learned` (the learned place it falls in, if any) and is
 * called `name` (the place's own name from the phone's geocoder, not its street address): null
 * when nothing is sure enough. A sure weekday place named like a school is School.
 */
export function promptFor(learned: LearnedPlace | null, name: string | null): { kind: PromptKind; why: PromptWhy } | null {
  const school = name !== null && isSchoolName(name);
  const work = name !== null && isWorkName(name);
  if (learned && learned.kind === 'home' && learned.pHome >= HOME_SURE.p && learned.nights >= HOME_SURE.nights && !school && !work) return { kind: 'home', why: 'nights' };
  if (learned && learned.kind === 'work' && learned.pWork >= WORK_SURE.p && learned.weekdays >= WORK_SURE.weekdays) return { kind: school ? 'school' : 'work', why: 'weekdays' };
  if (school) return { kind: 'school', why: 'name' };
  if (work) return { kind: 'work', why: 'name' };
  return null;
}
