import type { ComponentType } from 'react';

import type { FlowContext, StepId } from './flow';
import { ClanStep } from './steps/ClanStep';
import { DashcamStep } from './steps/DashcamStep';
import { HowStep } from './steps/HowStep';
import { LicenseStep } from './steps/LicenseStep';
import { LocationStep } from './steps/LocationStep';
import { MotionStep } from './steps/MotionStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { ReminderStep } from './steps/ReminderStep';
import { UsernameStep } from './steps/UsernameStep';

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

/** Every step id to the component that renders it. The last (clan) finishes onboarding itself. */
export const STEP_REGISTRY: Readonly<Record<StepId, ComponentType<StepProps>>> = {
  username: UsernameStep,
  license: LicenseStep,
  how: HowStep,
  motion: MotionStep,
  location: LocationStep,
  notifications: NotificationsStep,
  reminder: ReminderStep,
  dashcam: DashcamStep,
  clan: ClanStep,
};
