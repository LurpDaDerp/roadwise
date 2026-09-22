import {
  STEP_AVAILABLE,
  STEP_IDS,
  asAgeBand,
  asDrivingStage,
  isStepId,
  isInFlow,
  nextStep,
  onboardingHref,
  previousStep,
  resumeStep,
  sessionPlan,
  stepPosition,
  stepsFor,
  type FlowContext,
  type StepId,
} from '../flow';

/** An adult driver on iOS who has accepted the current Terms: the plainest flow. */
function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return {
    platform: 'ios',
    ageBand: '18_plus',
    drivingStage: 'new',
    termsCurrent: true,
    termsPublished: true,
    minorConsentMode: 'guardian_link_optional',
    features: { autoDetect: true, guardianInvites: false },
    ...over,
  };
}

const DRIVER_SETUP: StepId[] = ['location', 'motion', 'notifications', 'auto-detect', 'ready'];
const ALL_AVAILABLE = Object.fromEntries(STEP_IDS.map((s) => [s, true])) as Record<StepId, boolean>;

describe('stepsFor', () => {
  it('walks an adult driver through the driving setup, the same on iOS and Android', () => {
    expect(stepsFor(ctx({ platform: 'ios' }))).toEqual(DRIVER_SETUP);
    expect(stepsFor(ctx({ platform: 'android' }))).toEqual(DRIVER_SETUP);
  });

  it('puts terms first while the current Terms are not accepted, published or not', () => {
    expect(stepsFor(ctx({ termsCurrent: false }))).toEqual(['terms', ...DRIVER_SETUP]);
    // rev1: I7 — the step itself says what it can ask for while the documents are unpublished.
    expect(stepsFor(ctx({ termsCurrent: false, termsPublished: false }))).toEqual([
      'terms',
      ...DRIVER_SETUP,
    ]);
    expect(stepsFor(ctx({ termsCurrent: true, termsPublished: false }))).toEqual(DRIVER_SETUP);
  });

  it('asks for the profile while the age band or the driving stage is unknown', () => {
    expect(stepsFor(ctx({ ageBand: 'unknown' }))).toEqual(['profile', ...DRIVER_SETUP]);
    expect(stepsFor(ctx({ drivingStage: 'unknown' }))).toEqual(['profile', ...DRIVER_SETUP]);
    expect(
      stepsFor(
        ctx({
          termsCurrent: false,
          ageBand: 'unknown',
          drivingStage: 'unknown',
        })
      )
    ).toEqual(['terms', 'profile', ...DRIVER_SETUP]);
  });

  it('never offers the guardian step before the age band is known', () => {
    expect(
      stepsFor(
        ctx({
          ageBand: 'unknown',
          features: { autoDetect: true, guardianInvites: true },
        })
      )
    ).not.toContain('guardian');
  });

  it('blocks an under-13 account with the not-eligible step alone', () => {
    expect(stepsFor(ctx({ ageBand: 'u13' }))).toEqual(['not-eligible']);
    // No Terms, no profile, nothing else: the child cannot consent and the server refuses writes.
    expect(stepsFor(ctx({ ageBand: 'u13', termsCurrent: false, drivingStage: 'unknown' }))).toEqual(
      ['not-eligible']
    );
  });

  describe('a teen (13–17)', () => {
    const modes = ['guardian_link_optional', 'guardian_consent_required'] as const;

    it.each(modes)(
      'has no guardian step while guardian invites are off (%s)',
      (minorConsentMode) => {
        // rev1: I6 — the step is absent, not deferred: there is no redemption to invite anyone to.
        expect(
          stepsFor(
            ctx({
              ageBand: '13_17',
              minorConsentMode,
              features: { autoDetect: true, guardianInvites: false },
            })
          )
        ).toEqual(DRIVER_SETUP);
      }
    );

    it.each(modes)(
      'has the guardian step after the profile when invites are on (%s)',
      (minorConsentMode) => {
        expect(
          stepsFor(
            ctx({
              ageBand: '13_17',
              termsCurrent: false,
              drivingStage: 'unknown',
              minorConsentMode,
              features: { autoDetect: true, guardianInvites: true },
            })
          )
        ).toEqual(['terms', 'profile', 'guardian', ...DRIVER_SETUP]);
      }
    );

    it('is the only band that ever sees the guardian step', () => {
      expect(stepsFor(ctx({ features: { autoDetect: true, guardianInvites: true } }))).toEqual(
        DRIVER_SETUP
      );
    });
  });

  it('gives a non-driver no location, motion, notifications, auto-detect or camera step', () => {
    expect(stepsFor(ctx({ drivingStage: 'non_driver' }))).toEqual(['ready']);
    expect(stepsFor(ctx({ drivingStage: 'non_driver' }), ALL_AVAILABLE)).toEqual([
      'family',
      'ready',
    ]);
    expect(
      stepsFor(
        ctx({
          ageBand: '13_17',
          drivingStage: 'non_driver',
          features: { autoDetect: true, guardianInvites: true },
        })
      )
    ).toEqual(['guardian', 'ready']);
  });

  it('leaves auto-detect out when the feature is off', () => {
    expect(stepsFor(ctx({ features: { autoDetect: false, guardianInvites: false } }))).toEqual([
      'location',
      'motion',
      'notifications',
      'ready',
    ]);
  });

  it('holds camera (M7) and family (M6) back until their milestones make them available', () => {
    expect(STEP_AVAILABLE.camera).toBe(false);
    expect(STEP_AVAILABLE.family).toBe(false);
    expect(stepsFor(ctx())).not.toContain('camera');
    expect(stepsFor(ctx())).not.toContain('family');
    expect(stepsFor(ctx(), ALL_AVAILABLE)).toEqual([
      'location',
      'motion',
      'notifications',
      'auto-detect',
      'camera',
      'family',
      'ready',
    ]);
  });

  it.each(['permit', 'new', 'developing', 'experienced'] as const)(
    'treats %s as a driver',
    (drivingStage) => {
      expect(stepsFor(ctx({ drivingStage }))).toEqual(DRIVER_SETUP);
    }
  );

  it('always ends with ready unless the account is blocked', () => {
    for (const c of [ctx(), ctx({ drivingStage: 'non_driver' }), ctx({ termsCurrent: false })]) {
      expect(stepsFor(c).at(-1)).toBe('ready');
    }
  });
});

describe('nextStep', () => {
  it('moves forward through the flow and stops after ready', () => {
    expect(nextStep(ctx(), 'location')).toBe('motion');
    expect(nextStep(ctx(), 'notifications')).toBe('auto-detect');
    expect(nextStep(ctx(), 'ready')).toBeNull();
  });

  it('moves on from a step the context no longer lists, as when Terms were just accepted', () => {
    // The context updates after the terms step records consent; the step is gone from the list.
    expect(nextStep(ctx({ termsCurrent: true, ageBand: 'unknown' }), 'terms')).toBe('profile');
    expect(nextStep(ctx({ termsCurrent: true }), 'terms')).toBe('location');
  });

  it('sends a profile that came back under 13 to not-eligible, and nowhere after it', () => {
    expect(nextStep(ctx({ ageBand: 'u13' }), 'profile')).toBe('not-eligible');
    expect(nextStep(ctx({ ageBand: 'u13' }), 'not-eligible')).toBeNull();
  });

  it('skips steps the context leaves out', () => {
    expect(
      nextStep(ctx({ features: { autoDetect: false, guardianInvites: false } }), 'notifications')
    ).toBe('ready');
    expect(nextStep(ctx({ drivingStage: 'non_driver' }), 'profile')).toBe('ready');
  });
});

describe('previousStep', () => {
  it('goes back through the setup steps', () => {
    expect(previousStep(ctx(), 'motion')).toBe('location');
    expect(previousStep(ctx(), 'ready')).toBe('auto-detect');
  });

  it('never goes back into terms once they are accepted', () => {
    expect(previousStep(ctx({ termsCurrent: false }), 'location')).toBeNull();
    expect(previousStep(ctx({ termsCurrent: false, ageBand: 'unknown' }), 'profile')).toBeNull();
  });

  it('never goes back across a confirmed birth date', () => {
    const teen = ctx({
      ageBand: '13_17',
      features: { autoDetect: true, guardianInvites: true },
    });
    expect(previousStep(teen, 'guardian')).toBeNull();
    expect(previousStep(teen, 'location')).toBe('guardian');
    // Even with the profile still listed (stage unsaved), back never re-opens it.
    expect(previousStep(ctx({ drivingStage: 'unknown' }), 'location')).toBeNull();
  });

  it('has no way back from the first step or from not-eligible', () => {
    expect(previousStep(ctx(), 'location')).toBeNull();
    expect(previousStep(ctx({ ageBand: 'u13' }), 'not-eligible')).toBeNull();
  });

  it('steps over what the context leaves out', () => {
    expect(
      previousStep(ctx({ features: { autoDetect: false, guardianInvites: false } }), 'ready')
    ).toBe('notifications');
  });
});

describe('resumeStep', () => {
  it('starts at the first step with nothing saved', () => {
    expect(resumeStep(ctx(), null)).toBe('location');
    expect(resumeStep(ctx({ termsCurrent: false }), null)).toBe('terms');
  });

  it('returns to the saved step while it is still in the flow', () => {
    expect(resumeStep(ctx(), 'notifications')).toBe('notifications');
  });

  it('puts terms, the profile and the block ahead of any saved step', () => {
    expect(resumeStep(ctx({ termsCurrent: false }), 'notifications')).toBe('terms');
    expect(resumeStep(ctx({ drivingStage: 'unknown' }), 'motion')).toBe('profile');
    expect(resumeStep(ctx({ ageBand: 'u13' }), 'ready')).toBe('not-eligible');
  });

  it('clamps a saved step the flow no longer has to the next one it does', () => {
    expect(
      resumeStep(ctx({ features: { autoDetect: false, guardianInvites: false } }), 'auto-detect')
    ).toBe('ready');
    expect(resumeStep(ctx(), 'camera')).toBe('ready');
    expect(resumeStep(ctx({ drivingStage: 'non_driver' }), 'motion')).toBe('ready');
    // A step saved before the flow began (Terms, since accepted) resumes at the start.
    expect(resumeStep(ctx(), 'terms')).toBe('location');
    expect(resumeStep(ctx(), 'profile')).toBe('location');
  });

  it('always lands on a step that is in the flow', () => {
    const contexts = [
      ctx(),
      ctx({ termsCurrent: false }),
      ctx({ ageBand: 'u13' }),
      ctx({ drivingStage: 'non_driver' }),
      ctx({
        ageBand: '13_17',
        features: { autoDetect: false, guardianInvites: true },
      }),
    ];
    for (const c of contexts) {
      for (const saved of [null, ...STEP_IDS]) expect(isInFlow(c, resumeStep(c, saved))).toBe(true);
    }
  });
});

describe('sessionPlan and stepPosition', () => {
  it('numbers the steps of the flow from one', () => {
    const plan = sessionPlan(ctx(), 'motion');
    expect(plan).toEqual(DRIVER_SETUP);
    expect(stepPosition(plan, 'motion')).toEqual({ index: 2, total: 5 });
  });

  it('keeps the steps already passed this session in the count, so it never runs backwards', () => {
    const first = sessionPlan(ctx({ termsCurrent: false, drivingStage: 'unknown' }), 'terms');
    expect(stepPosition(first, 'terms')).toEqual({ index: 1, total: 7 });
    // Terms accepted and the profile saved: both leave `stepsFor`, but not the session's count.
    const second = sessionPlan(ctx({ drivingStage: 'unknown' }), 'profile', first);
    expect(stepPosition(second, 'profile')).toEqual({ index: 2, total: 7 });
    const third = sessionPlan(ctx(), 'location', second);
    expect(stepPosition(third, 'location')).toEqual({ index: 3, total: 7 });
  });

  it('grows when the profile reveals a step that was not known before', () => {
    const before = sessionPlan(ctx({ ageBand: 'unknown' }), 'profile');
    const teen = ctx({
      ageBand: '13_17',
      features: { autoDetect: true, guardianInvites: true },
    });
    const after = sessionPlan(teen, 'guardian', before);
    expect(stepPosition(after, 'guardian')).toEqual({ index: 2, total: 7 });
  });

  it('drops steps ahead that the context no longer includes', () => {
    const before = sessionPlan(ctx(), 'location');
    const after = sessionPlan(
      ctx({ features: { autoDetect: false, guardianInvites: false } }),
      'motion',
      before
    );
    expect(after).toEqual(['location', 'motion', 'notifications', 'ready']);
  });
});

describe('ids, parsing and hrefs', () => {
  it('recognises every step id and nothing else', () => {
    for (const id of STEP_IDS) expect(isStepId(id)).toBe(true);
    for (const bad of ['start', 'Terms', '', 'ready/', undefined, null, 3])
      expect(isStepId(bad)).toBe(false);
  });

  it('reads unknown profile values as unknown', () => {
    expect(asAgeBand('13_17')).toBe('13_17');
    expect(asAgeBand('adult')).toBe('unknown');
    expect(asDrivingStage('non_driver')).toBe('non_driver');
    expect(asDrivingStage('bogus')).toBe('unknown');
  });

  it('builds the stepper route for a step and for start', () => {
    expect(onboardingHref('motion')).toBe('/(onboarding)/motion');
    expect(onboardingHref('start')).toBe('/(onboarding)/start');
  });
});
