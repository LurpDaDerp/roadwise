/** @jest-environment node */
import { SAFETY_DISCLAIMER } from '@/features/auth/legal';
import { BANNED_COPY } from '@/notifications/catalog';

import { onboardingCopy } from '../copy';

/**
 * A4 says "no hint about thresholds" (product spec §7.A). Applied to the words this build prints on
 * the profile step and the confirmation sheet — never to what a driver types (rev1: m).
 */
const THRESHOLD =
  /\b(1[0-9]|2[01])\b|thirteen|eighteen|\bages?\b|\bolder\b|\byounger\b|\badults?\b|\bminors?\b|\bteens?\b|\bkids?\b|\bchild|old enough|years old|\beligib/i;

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return [];
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe('onboarding copy', () => {
  const a4 = [...strings(onboardingCopy.profile), ...strings(onboardingCopy.confirmBirthDate)];

  it('has strings to check', () => {
    expect(a4.length).toBeGreaterThan(20);
  });

  it.each(a4.map((s) => [s]))('A4 / the sheet: %p names no age threshold', (s) => {
    expect(s).not.toMatch(THRESHOLD);
  });

  it('the threshold check bites', () => {
    for (const s of ['You must be 13 or older', 'Adults only', 'For drivers aged 16+', 'Under 18?']) {
      expect(s).toMatch(THRESHOLD);
    }
  });

  it('the sheet quotes the date and nothing else about it', () => {
    expect(onboardingCopy.confirmBirthDate.title).toBe('Is this right?');
    expect(onboardingCopy.confirmBirthDate.fixed).toBe("Your birth date can't be changed later.");
  });

  it('the Terms step quotes the disclaimer word for word', () => {
    expect(onboardingCopy.terms.acknowledge).toBe(`I understand ${SAFETY_DISCLAIMER}.`);
    expect(onboardingCopy.terms.acknowledge).toBe(
      'I understand RoadWise is a coaching aid and may miss or misreport events.'
    );
    expect(onboardingCopy.terms.acknowledge).not.toMatch(/terms|privacy/i);
  });

  it('the block screen says the briefed words', () => {
    expect(onboardingCopy.notEligible.title).toBe('RoadWise is for people 13 and older');
    expect(onboardingCopy.notEligible.kept).toBe("We've kept only what we need to remember this.");
    expect(onboardingCopy.notEligible.signOut).toBe('Sign out');
  });

  const all = [
    ...strings(onboardingCopy.terms),
    ...a4,
    ...strings(onboardingCopy.notEligible),
  ];
  it.each(all.map((s) => [s]))('%p makes no banned promise', (s) => {
    for (const banned of BANNED_COPY) expect(s).not.toMatch(banned);
  });
});
