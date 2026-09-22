import type { ComponentType } from 'react';

import type { FlowContext, StepId } from './flow';
import { AutoDetectStep } from './steps/AutoDetectStep';
import { GuardianStep } from './steps/GuardianStep';
import { LocationStep } from './steps/LocationStep';
import { MotionStep } from './steps/MotionStep';
import { NotEligibleStep } from './steps/NotEligibleStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { PlaceholderStep } from './steps/PlaceholderStep';
import { ProfileStep } from './steps/ProfileStep';
import { ReadyStep } from './steps/ReadyStep';
import { TermsStep } from './steps/TermsStep';

/**
 * What the stepper hands every step. A step renders its own `StepFrame` (the position comes from
 * the stepper through context), calls `onNext` when it is done — after any write it makes and any
 * `refreshProfile` it needs, since the next step is chosen from the newest context — and shows
 * Back only when `onBack` is given.
 */
export interface StepProps {
  ctx: FlowContext;
  onNext(): void;
  onBack?: () => void;
}

function placeholderFor(step: StepId): ComponentType<StepProps> {
  function Placeholder(props: StepProps) {
    return <PlaceholderStep {...props} step={step} />;
  }
  Placeholder.displayName = `PlaceholderStep(${step})`;
  return Placeholder;
}

/**
 * Every step id to the component that renders it. Only the OB lane edits this table: Task 12
 * replaces `terms`, `profile` and `not-eligible`; Task 13 `guardian`; Task 14 `location`, `motion`,
 * `notifications`, `auto-detect` and `ready`. `camera` (M7) and `family` (M6) stay placeholders and
 * out of every flow until `STEP_AVAILABLE` turns them on.
 */
export const STEP_REGISTRY: Readonly<Record<StepId, ComponentType<StepProps>>> = {
  terms: TermsStep,
  profile: ProfileStep,
  'not-eligible': NotEligibleStep,
  // Dark until M6: `stepsFor` lists it only while `guardian_invites` is on (rev1: I6).
  guardian: GuardianStep,
  location: LocationStep,
  motion: MotionStep,
  notifications: NotificationsStep,
  'auto-detect': AutoDetectStep,
  camera: placeholderFor('camera'),
  family: placeholderFor('family'),
  // Finishes onboarding itself (`finishOnboarding`), so the stepper's exit after it is never used.
  ready: ReadyStep,
};
