import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import {
  ONBOARDING_PENDING_HREF_KEY,
  ONBOARDING_STEP_KEY,
  clearOnboardingState,
  readSavedStep,
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

  it('clears the saved step and the pending link together', async () => {
    const s = await settings();
    await saveStep(s, 'ready');
    await s.set(ONBOARDING_PENDING_HREF_KEY, '/trips/abc');
    await s.set('units', 'imperial');
    await clearOnboardingState(s);
    expect(await readSavedStep(s)).toBeNull();
    expect(await s.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
    expect(await s.get('units')).toBe('imperial');
  });
});
