import type { ComponentType } from 'react';

import type { FlowContext, StepId } from './flow';
import { LocationStep } from './steps/LocationStep';
import { MotionStep } from './steps/MotionStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { PlaceholderStep } from './steps/PlaceholderStep';

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

const placeholder = (step: StepId): ComponentType<StepProps> =>
  function Placeholder(props: StepProps) {
    return <PlaceholderStep {...props} step={step} />;
  };

/** Every step id to the component that renders it. The placeholders are filled in by WP9. */
export const STEP_REGISTRY: Readonly<Record<StepId, ComponentType<StepProps>>> = {
  username: placeholder('username'),
  license: placeholder('license'),
  how: placeholder('how'),
  motion: MotionStep,
  location: LocationStep,
  notifications: NotificationsStep,
  clan: placeholder('clan'),
};
