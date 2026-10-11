import {
  STEP_IDS,
  isInFlow,
  isStepId,
  nextStep,
  onboardingHref,
  previousStep,
  resumeStep,
  sessionPlan,
  stepPosition,
  stepsFor,
  type FlowContext,
} from '../flow';

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { platform: 'ios', hasUsername: false, ...over };
}

const AFTER_USERNAME = ['license', 'how', 'motion', 'location', 'notifications', 'dashcam', 'clan'];

describe('stepsFor', () => {
  it('is the v3 order: username → license → how → motion → location → notifications → clan', () => {
    expect(STEP_IDS).toEqual(['username', ...AFTER_USERNAME]);
    expect(stepsFor(ctx())).toEqual(['username', ...AFTER_USERNAME]);
    expect(stepsFor(ctx({ platform: 'android' }))).toEqual(['username', ...AFTER_USERNAME]);
  });

  it('drops the username once it is claimed', () => {
    expect(stepsFor(ctx({ hasUsername: true }))).toEqual(AFTER_USERNAME);
    expect(isInFlow(ctx({ hasUsername: true }), 'username')).toBe(false);
  });
});

describe('navigation', () => {
  it('moves forward in canonical order, even from a step the context just dropped', () => {
    expect(nextStep(ctx(), 'username')).toBe('license');
    expect(nextStep(ctx({ hasUsername: true }), 'username')).toBe('license');
    expect(nextStep(ctx(), 'notifications')).toBe('dashcam');
    expect(nextStep(ctx(), 'dashcam')).toBe('clan');
    expect(nextStep(ctx(), 'clan')).toBeNull();
  });

  it('goes back, but never into or out of the username step', () => {
    expect(previousStep(ctx(), 'username')).toBeNull();
    expect(previousStep(ctx(), 'license')).toBeNull();
    expect(previousStep(ctx({ hasUsername: true }), 'license')).toBeNull();
    expect(previousStep(ctx(), 'motion')).toBe('how');
    expect(previousStep(ctx(), 'clan')).toBe('dashcam');
    expect(previousStep(ctx(), 'dashcam')).toBe('notifications');
  });

  it('resumes at the username until it is claimed, then at the saved step', () => {
    expect(resumeStep(ctx(), null)).toBe('username');
    expect(resumeStep(ctx(), 'location')).toBe('username');
    expect(resumeStep(ctx({ hasUsername: true }), null)).toBe('license');
    expect(resumeStep(ctx({ hasUsername: true }), 'location')).toBe('location');
    expect(resumeStep(ctx({ hasUsername: true }), 'username')).toBe('license');
  });
});

describe('the step count', () => {
  it('keeps steps passed this session, so the count never runs backwards', () => {
    const plan = sessionPlan(ctx({ hasUsername: true }), 'license', ['username']);
    expect(plan).toEqual(['username', ...AFTER_USERNAME]);
    expect(stepPosition(plan, 'license')).toEqual({ index: 2, total: 8 });
  });

  it('an unknown step counts as the first', () => {
    expect(stepPosition([], 'clan')).toEqual({ index: 1, total: 1 });
  });
});

describe('ids and hrefs', () => {
  it('knows its own ids only', () => {
    expect(isStepId('motion')).toBe(true);
    for (const old of ['terms', 'profile', 'guardian', 'not-eligible', 'auto-detect', 'family', 'ready', 7]) {
      expect(isStepId(old)).toBe(false);
    }
  });

  it('builds the stepper route', () => {
    expect(onboardingHref('start')).toBe('/(onboarding)/start');
    expect(onboardingHref('clan')).toBe('/(onboarding)/clan');
  });
});
