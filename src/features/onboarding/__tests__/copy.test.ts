/** @jest-environment node */
import { onboardingCopy } from '../copy';
import { STEP_IDS } from '../flow';

/** Promises the app never makes: score guarantees, streak pressure, points as money, shouting. */
const BANNED_COPY: readonly RegExp[] = [
  /never lowers|can(no|')t go down|never decays/i,
  /lose your streak|about to lose|hurry|last chance/i,
  /\$|\bcash\b|money|dollars?|gift ?cards?|redeem|prizes?|insurance|discounts?/i,
  /!/,
];

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return [];
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe('onboarding copy', () => {
  const all = strings(onboardingCopy);

  it('names every step', () => {
    for (const id of STEP_IDS) expect(onboardingCopy.stepTitles[id].length).toBeGreaterThan(0);
  });

  it('never asks for Always location, an age or a birth date', () => {
    for (const s of all) expect(s).not.toMatch(/\balways\b|all the time|birth|\bage\b|guardian|family/i);
  });

  it.each(all.map((s) => [s]))('%p makes no banned promise', (s) => {
    for (const banned of BANNED_COPY) expect(s).not.toMatch(banned);
  });

  it('says what motion access is for (the walking end and the reminder) and that speed and braking need none', () => {
    expect(onboardingCopy.motion.body).toBe(
      'Lets RoadWise stop a drive you forgot to end once you walk away from your car. The optional forgot-to-start reminder uses it too. Speed and braking are measured either way.'
    );
    expect(onboardingCopy.motion.denied).toBe(
      'Motion access is off. Drives still record, and one you forget to end stops after 15 min parked. You can turn it on in Settings.'
    );
    for (const s of strings(onboardingCopy.motion)) expect(s).not.toMatch(/hard braking|detect/i);
  });

  it('says why each permission is asked, in one line where it is asked', () => {
    expect(onboardingCopy.location.body).toBe('RoadWise uses precise location to measure speed and miles during a drive you start.');
    expect(onboardingCopy.location.approximate).toBe("Location is set to approximate, so drives can't record. Turn on Precise Location in Settings.");
    expect(onboardingCopy.notifications.body).toBe(
      'Get your forgot-to-start reminder, your Sunday recap, and a heads-up when a friend adds you.'
    );
  });
});
