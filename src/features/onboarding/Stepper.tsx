import { Redirect, useFocusEffect, useRouter, type Href } from 'expo-router';
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
import { readSavedPlan, readSavedStep, savePlan, saveStep } from './state';
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
 * one screen. It is also saved beside the step (`onboarding.plan`), so `start` can carry the count
 * across a restart.
 */
let sessionShown: StepId[] = [];

/** For tests. */
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

  // Focus-scoped (review T11 I1): while another screen covers `start` — the background
  // disclosure, a drive — nothing is replaced under it (I10). The resume runs when onboarding is
  // focused again, with the context as it is then.
  useFocusEffect(
    useCallback(() => {
      if (ctx === null) return;
      let cancelled = false;
      void Promise.all([
        readSavedStep(settings).catch(() => null),
        readSavedPlan(settings).catch(() => []),
      ]).then(([saved, passed]) => {
        if (cancelled) return;
        // A resumed walk keeps the steps it had already passed, so the count carries across a
        // restart instead of starting again at 1 (review T11 m1).
        sessionShown = saved === null ? [] : passed;
        router.replace(onboardingHref(resumeStep(ctx, saved)));
      });
      return () => {
        cancelled = true;
      };
    }, [ctx, settings, router])
  );

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
    // Resume falls back to the first step of the flow on a failed write; nothing is lost but a
    // few taps.
    void saveStep(settings, step).catch(() => {});
    void savePlan(settings, plan).catch(() => {});
  }, [settings, step, plan]);

  const onNext = useCallback(() => {
    const next = nextStep(latest.current, step);
    router.replace(next ? onboardingHref(next) : AFTER_LAST_STEP);
  }, [router, step]);

  const back = previousStep(ctx, step);
  const onBack = useMemo(
    () => (back ? () => router.replace(onboardingHref(back)) : undefined),
    [back, router]
  );

  // Live only while this step is focused (review T11 I1). A screen presented over the step — the
  // background disclosure, a drive screen — owns the back button; a listener left live under it
  // would replace a route onboarding does not show, and on a drive route that is a reroute
  // during a recording (I10).
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!onBack) return false;
        onBack();
        return true;
      });
      return () => sub.remove();
    }, [onBack])
  );

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
