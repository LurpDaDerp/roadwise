import type { ComponentType } from 'react';

import type { FlowContext, StepId } from './flow';
import { DashcamStep } from './steps/DashcamStep';
import { HowStep } from './steps/HowStep';
import { LocationStep } from './steps/LocationStep';
import { MotionStep } from './steps/MotionStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { UsernameStep } from './steps/UsernameStep';

/**
 * What the stepper hands every step. A step renders its own `StepFrame` (the position comes from
 * the stepper through context), calls `onNext` when it is done — after any write it makes and any
 * `refreshProfile` it needs, since the next step is chosen from the newest context — and shows
 * Back only when `onBack` is given.
 *
 * After the last step `onNext` finishes onboarding. Its promise says whether the driver left the
 * step: false when finishing failed (the frame then says so and the step can be pressed again).
 */
export interface StepProps {
  ctx: FlowContext;
  onNext(): void | Promise<boolean>;
  onBack?: () => void;
}

/** Every step id to the component that renders it. */
export const STEP_REGISTRY: Readonly<Record<StepId, ComponentType<StepProps>>> = {
  username: UsernameStep,
  how: HowStep,
  location: LocationStep,
  motion: MotionStep,
  notifications: NotificationsStep,
  dashcam: DashcamStep,
};
