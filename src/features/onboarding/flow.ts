import type { Href } from 'expo-router';

/**
 * The onboarding flow: username → license → how it works → motion → location → notifications →
 * forgot-to-start reminder (optional) → DashPal (optional) → clan (optional) → Home.
 *
 * Every step has one fixed place in `STEP_IDS`; the context only decides which of them this driver
 * walks. Navigation works on that canonical order rather than on a list index, so a step the context
 * has just dropped (the username, once claimed) still knows what comes after it.
 *
 * Nothing here gates a feature on a permission: the permission steps are offered, and every one of
 * them can be passed without granting anything.
 */

/** Canonical order. Adding a step means adding it here and in the registry. */
export const STEP_IDS = [
  'username',
  'license',
  'how',
  'motion',
  'location',
  'notifications',
  'reminder',
  'dashcam',
  'clan',
] as const;

export type StepId = (typeof STEP_IDS)[number];

/** The route's own pseudo-step: resolves to `resumeStep` and never renders. */
export type StepParam = StepId | 'start';

export type Platform = 'ios' | 'android';

export interface FlowContext {
  platform: Platform;
  /** The account has claimed a username: the username step is done and never re-entered. */
  hasUsername: boolean;
}

export interface StepPosition {
  /** One-based. */
  index: number;
  total: number;
}

const ORDER: Readonly<Record<StepId, number>> = Object.fromEntries(
  STEP_IDS.map((id, i) => [id, i])
) as Record<StepId, number>;

/** Steps that must be done before anything else and are never re-entered by going back. */
const GATE_STEPS: ReadonlySet<StepId> = new Set<StepId>(['username']);

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value);
}

/** The steps this driver walks, in order. */
export function stepsFor(ctx: FlowContext): StepId[] {
  return STEP_IDS.filter((id) => id !== 'username' || !ctx.hasUsername);
}

export function isInFlow(ctx: FlowContext, step: StepId): boolean {
  return stepsFor(ctx).includes(step);
}

/** The step after `current`, or null when `current` is the last. `current` need not be listed. */
export function nextStep(ctx: FlowContext, current: StepId): StepId | null {
  return stepsFor(ctx).find((id) => ORDER[id] > ORDER[current]) ?? null;
}

/** The step Back returns to, or null for none. Never into the username step. */
export function previousStep(ctx: FlowContext, current: StepId): StepId | null {
  if (GATE_STEPS.has(current)) return null;
  const earlier = stepsFor(ctx).filter((id) => ORDER[id] < ORDER[current]);
  const candidate = earlier.at(-1);
  return candidate === undefined || GATE_STEPS.has(candidate) ? null : candidate;
}

/**
 * Where a driver re-enters the flow: a gate step first, otherwise the saved step, or — when the
 * flow no longer has it — the next step it does have. Always a step of `stepsFor(ctx)`.
 */
export function resumeStep(ctx: FlowContext, saved: StepId | null): StepId {
  const steps = stepsFor(ctx);
  const first = steps[0] ?? 'clan';
  if (saved === null || GATE_STEPS.has(first)) return first;
  return steps.find((id) => ORDER[id] >= ORDER[saved]) ?? steps.at(-1) ?? first;
}

/**
 * The steps counted for "Step n of total": the flow as the context has it now, `current`, and the
 * steps already passed this session — kept even after the context drops them, so the count never
 * runs backwards when the username is claimed.
 */
export function sessionPlan(
  ctx: FlowContext,
  current: StepId,
  shown: readonly StepId[] = []
): StepId[] {
  const keep = new Set<StepId>([
    ...shown.filter((id) => ORDER[id] < ORDER[current]),
    current,
    ...stepsFor(ctx),
  ]);
  return STEP_IDS.filter((id) => keep.has(id));
}

export function stepPosition(plan: readonly StepId[], current: StepId): StepPosition {
  const index = plan.indexOf(current);
  return index < 0
    ? { index: 1, total: Math.max(plan.length, 1) }
    : { index: index + 1, total: plan.length };
}

/** The stepper route for a step. Cast: the typed-routes union lags a dynamic route. */
export function onboardingHref(step: StepParam): Href {
  return `/(onboarding)/${step}` as Href;
}
