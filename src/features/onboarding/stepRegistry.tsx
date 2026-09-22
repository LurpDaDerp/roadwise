import type { ComponentType } from 'react';

import type { FlowContext, StepId } from './flow';
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
  terms: placeholderFor('terms'),
  profile: placeholderFor('profile'),
  'not-eligible': placeholderFor('not-eligible'),
  guardian: placeholderFor('guardian'),
  location: placeholderFor('location'),
  motion: placeholderFor('motion'),
  notifications: placeholderFor('notifications'),
  'auto-detect': placeholderFor('auto-detect'),
  camera: placeholderFor('camera'),
  family: placeholderFor('family'),
  ready: placeholderFor('ready'),
};
