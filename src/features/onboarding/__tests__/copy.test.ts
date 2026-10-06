/** @jest-environment node */
import { BANNED_COPY } from '@/notifications/catalog';

import { onboardingCopy } from '../copy';
import { STEP_IDS } from '../flow';

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
});
