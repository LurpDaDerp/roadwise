import { Redirect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BackHandler, View } from 'react-native';

import type { SettingsRepo } from '@/data/db/settings';
import { Screen, Skeleton, useTheme } from '@/ui';

import { onboardingCopy } from './copy';
import {
  isInFlow,
  isStepId,
  nextStep,
  onboardingHref,
  previousStep,
  resumeStep,
  sessionPlan,
  stepPosition,
  type FlowContext,
  type StepId,
} from './flow';
import { readSavedStep, saveStep } from './state';
import { STEP_REGISTRY } from './stepRegistry';
import { StepPositionProvider } from './StepFrame';

/**
 * Where the stepper leaves the flow after the last step. Task 14 replaces this with
 * `finishOnboarding` from the ready step, which marks the profile onboarded and honours a pending
 * deep link.
 */
const AFTER_LAST_STEP = '/(tabs)/home' as Href;

/**
 * The steps passed this session, so "Step n of total" survives a step being replaced by the next.
 * Module state on purpose: each step is its own screen, and the count belongs to the walk, not to
 * one screen. Every pass through `start` begins a new walk.
 */
let sessionShown: StepId[] = [];

/** For tests, and for `start`. */
export function resetSessionPlan(): void {
  sessionShown = [];
}

/**
 * The single onboarding stepper behind `app/(onboarding)/[step].tsx`.
 *
 * - `start` resolves to `resumeStep(ctx, saved)` once the context is known, and never renders.
 * - Any other value that is not a step id redirects to `start`.
 * - A step id this driver's flow does not have redirects to the step the flow resumes at, taking
 *   the requested step as the saved one — so a step that has just done its job (Terms accepted,
 *   the profile saved) moves on, and a stray link to a held-back step lands inside the flow.
 * - Otherwise the registered step renders, and is saved as the place to resume.
 *
 * Forward and Back both `replace`: the stack holds one onboarding screen, so neither a swipe nor
 * the Android back button can walk back into Terms or across a confirmed birth date. The Android
 * back button is mapped onto Back and left to the system where there is no Back.
 *
 * Nothing here reroutes out of onboarding on its own; leaving the flow (and never doing so while a
 * drive records, I10) is the gate's job (Task 17).
 */
export function OnboardingStepper({
  step,
  ctx,
  settings,
}: {
  step: string | undefined;
  ctx: FlowContext | null;
  settings: SettingsRepo;
}) {
  if (step === 'start') return <ResumeFromStart ctx={ctx} settings={settings} />;
  if (!isStepId(step)) return <Redirect href={onboardingHref('start')} />;
  if (ctx === null) return <StepLoading />;
  if (!isInFlow(ctx, step)) return <Redirect href={onboardingHref(resumeStep(ctx, step))} />;
  return <ActiveStep key={step} step={step} ctx={ctx} settings={settings} />;
}

function ResumeFromStart({ ctx, settings }: { ctx: FlowContext | null; settings: SettingsRepo }) {
  const router = useRouter();

  useEffect(() => {
    if (ctx === null) return;
    let cancelled = false;
    void readSavedStep(settings)
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return;
        resetSessionPlan();
        router.replace(onboardingHref(resumeStep(ctx, saved)));
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, settings, router]);

  return <StepLoading />;
}

function ActiveStep({
  step,
  ctx,
  settings,
}: {
  step: StepId;
  ctx: FlowContext;
  settings: SettingsRepo;
}) {
  const router = useRouter();
  // A step calls onNext after its own writes and `refreshProfile`; the newest context decides.
  const latest = useRef(ctx);
  useLayoutEffect(() => {
    latest.current = ctx;
  }, [ctx]);

  const plan = useMemo(() => sessionPlan(ctx, step, sessionShown), [ctx, step]);
  const position = useMemo(() => stepPosition(plan, step), [plan, step]);

  useEffect(() => {
    sessionShown = plan;
  }, [plan]);

  useEffect(() => {
    void saveStep(settings, step).catch(() => {
      // Resume falls back to the first step of the flow; nothing is lost but a few taps.
    });
  }, [settings, step]);

  const onNext = useCallback(() => {
    const next = nextStep(latest.current, step);
    router.replace(next ? onboardingHref(next) : AFTER_LAST_STEP);
  }, [router, step]);

  const back = previousStep(ctx, step);
  const onBack = useMemo(
    () => (back ? () => router.replace(onboardingHref(back)) : undefined),
    [back, router]
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!onBack) return false;
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const Step = STEP_REGISTRY[step];
  return (
    <StepPositionProvider value={position}>
      <Step ctx={ctx} onNext={onNext} onBack={onBack} />
    </StepPositionProvider>
  );
}

/** The frame's shape, unprinted, while the profile or the saved step is read. */
function StepLoading() {
  const th = useTheme();
  return (
    <Screen>
      <View
        accessible
        accessibilityLabel={onboardingCopy.frame.loading}
        style={{ flexGrow: 1, gap: th.space.lg }}
      >
        <Skeleton width="100%" height={3} radius={th.radius.pill} />
        <View style={{ gap: th.space.md, paddingTop: th.space.xxl }}>
          <Skeleton width="70%" height={34} radius={th.radius.sm} />
          <Skeleton width="100%" height={22} radius={th.radius.sm} />
          <Skeleton width="85%" height={22} radius={th.radius.sm} />
        </View>
      </View>
      <Skeleton width="100%" height={52} radius={th.radius.md} />
    </Screen>
  );
}
