import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import {
  ONBOARDING_PENDING_HREF_KEY,
  ONBOARDING_PLAN_KEY,
  ONBOARDING_STEP_KEY,
  clearOnboardingState,
  readSavedPlan,
  readSavedStep,
  savePlan,
  saveStep,
} from '../state';

async function settings() {
  return createSettingsRepo(await createTestDb());
}

describe('onboarding state', () => {
  it('uses the keys the gate and finish share', () => {
    expect(ONBOARDING_STEP_KEY).toBe('onboarding.step');
    expect(ONBOARDING_PENDING_HREF_KEY).toBe('onboarding.pendingHref');
  });

  it('reads nothing before a step is saved', async () => {
    expect(await readSavedStep(await settings())).toBeNull();
  });

  it('saves and reads back the step', async () => {
    const s = await settings();
    await saveStep(s, 'motion');
    expect(await readSavedStep(s)).toBe('motion');
    expect(await s.get(ONBOARDING_STEP_KEY)).toBe('motion');
  });

  it('reads a stored value that is not a step id as nothing saved', async () => {
    const s = await settings();
    await s.set(ONBOARDING_STEP_KEY, 'retired-step');
    expect(await readSavedStep(s)).toBeNull();
    await s.set(ONBOARDING_STEP_KEY, { step: 'motion' });
    expect(await readSavedStep(s)).toBeNull();
  });

  it('saves the count of the walk beside the step, dropping ids this build does not know', async () => {
    const s = await settings();
    expect(ONBOARDING_PLAN_KEY).toBe('onboarding.plan');
    expect(await readSavedPlan(s)).toEqual([]);
    await savePlan(s, ['terms', 'location', 'ready']);
    expect(await readSavedPlan(s)).toEqual(['terms', 'location', 'ready']);
    await s.set(ONBOARDING_PLAN_KEY, ['terms', 'retired-step', 7, 'ready']);
    expect(await readSavedPlan(s)).toEqual(['terms', 'ready']);
    await s.set(ONBOARDING_PLAN_KEY, 'terms');
    expect(await readSavedPlan(s)).toEqual([]);
  });

  it('clears the saved step and the pending link together', async () => {
    const s = await settings();
    await saveStep(s, 'ready');
    await savePlan(s, ['location', 'ready']);
    await s.set(ONBOARDING_PENDING_HREF_KEY, '/trips/abc');
    await s.set('units', 'imperial');
    await clearOnboardingState(s);
    expect(await readSavedStep(s)).toBeNull();
    expect(await readSavedPlan(s)).toEqual([]);
    expect(await s.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
    expect(await s.get('units')).toBe('imperial');
  });
});
