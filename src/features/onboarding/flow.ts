import type { Href } from 'expo-router';

/**
 * The onboarding flow as a pure function of who the driver is (A4–A12).
 *
 * Every step has one fixed place in `STEP_IDS`; a context only decides which of them this driver
 * walks. Navigation works on that canonical order rather than on a list index, so a step the
 * context has just dropped (Terms the moment they are accepted, the profile once it is saved) still
 * knows what comes after it.
 *
 * Nothing here gates a feature on a permission (D12): the permission steps are in the flow to be
 * offered, and every one of them can be passed without granting anything.
 */

/** Canonical order. Adding a step means adding it here, in `STEP_AVAILABLE` and in the registry. */
export const STEP_IDS = [
  'terms',
  'profile',
  'not-eligible',
  'guardian',
  'location',
  'motion',
  'notifications',
  'auto-detect',
  'camera',
  'family',
  'ready',
] as const;

export type StepId = (typeof STEP_IDS)[number];

/** The route's own pseudo-step: resolves to `resumeStep` and never renders. */
export type StepParam = StepId | 'start';

/**
 * Steps whose milestone has not shipped are held out of every flow: camera setup (A10) arrives
 * with M7, the family asks (A11) with M6. Flip the flag in the milestone that builds the step.
 */
export const STEP_AVAILABLE: Readonly<Record<StepId, boolean>> = {
  terms: true,
  profile: true,
  'not-eligible': true,
  guardian: true,
  location: true,
  motion: true,
  notifications: true,
  'auto-detect': true,
  camera: false,
  family: false,
  ready: true,
};

export type Platform = 'ios' | 'android';
/** `profiles.age_band` (0001): derived on the server from the confirmed birth date. */
export type AgeBand = 'unknown' | 'u13' | '13_17' | '18_plus';
/** `profiles.driving_stage` as widened by 0006_onboarding. */
export type DrivingStage =
  'unknown' | 'permit' | 'new' | 'developing' | 'experienced' | 'non_driver';
/** `app_config.minor_consent_mode`. Stays `guardian_link_optional` until M6 ships redemption (I6). */
export type MinorConsentMode = 'guardian_link_optional' | 'guardian_consent_required';

export interface FlowContext {
  platform: Platform;
  ageBand: AgeBand;
  drivingStage: DrivingStage;
  /**
   * The terms step has done everything it can for the current versions: both consents recorded
   * when Terms and Privacy are published, the disclaimer acknowledged when they are not (I7).
   */
  termsCurrent: boolean;
  /** Both documents have a URL. The terms step reads it; the flow does not branch on it. */
  termsPublished: boolean;
  minorConsentMode: MinorConsentMode;
  features: { autoDetect: boolean; guardianInvites: boolean };
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
const GATE_STEPS: ReadonlySet<StepId> = new Set<StepId>(['terms', 'profile', 'not-eligible']);

const AGE_BANDS: readonly AgeBand[] = ['unknown', 'u13', '13_17', '18_plus'];
const DRIVING_STAGES: readonly DrivingStage[] = [
  'unknown',
  'permit',
  'new',
  'developing',
  'experienced',
  'non_driver',
];

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value);
}

/** A server value this build does not know is treated as not yet known, never as a guess. */
export function asAgeBand(value: string | null | undefined): AgeBand {
  return (AGE_BANDS as readonly (string | null | undefined)[]).includes(value)
    ? (value as AgeBand)
    : 'unknown';
}

export function asDrivingStage(value: string | null | undefined): DrivingStage {
  return (DRIVING_STAGES as readonly (string | null | undefined)[]).includes(value)
    ? (value as DrivingStage)
    : 'unknown';
}

/**
 * The steps this driver walks, in order.
 *
 * - Under 13: the block and nothing else — no Terms (the child cannot consent, and the server
 *   refuses the write) and no profile (it has already been minimised).
 * - Terms first while they are not current; the step itself handles the unpublished case (I7).
 * - The profile while the age band or the driving stage is unknown. Until it is saved the rest of
 *   the list is provisional: an unknown band gets no guardian step, an unknown stage is walked as
 *   a driver. The list is recomputed from the saved profile.
 * - The guardian step only for a known 13–17 band with guardian invites on (I6: with the flag off
 *   there is nothing a guardian could redeem, so the step is absent in every consent mode).
 * - A non-driver gets no location, motion, notifications, auto-detect or camera: every live
 *   notification type is about driving; M6 adds the family asks.
 * - Auto-detect only while the feature is on. `ready` always last.
 *
 * `available` exists for tests and for the milestone that turns camera or family on.
 */
export function stepsFor(
  ctx: FlowContext,
  available: Readonly<Record<StepId, boolean>> = STEP_AVAILABLE
): StepId[] {
  if (ctx.ageBand === 'u13') return ['not-eligible'];

  const driver = ctx.drivingStage !== 'non_driver';
  const wanted: Record<StepId, boolean> = {
    terms: !ctx.termsCurrent,
    profile: ctx.ageBand === 'unknown' || ctx.drivingStage === 'unknown',
    'not-eligible': false,
    guardian: ctx.ageBand === '13_17' && ctx.features.guardianInvites,
    location: driver,
    motion: driver,
    notifications: driver,
    'auto-detect': driver && ctx.features.autoDetect,
    camera: driver,
    family: true,
    ready: true,
  };
  return STEP_IDS.filter((id) => wanted[id] && available[id]);
}

export function isInFlow(ctx: FlowContext, step: StepId): boolean {
  return stepsFor(ctx).includes(step);
}

/** The step after `current`, or null when `current` is the last. `current` need not be listed. */
export function nextStep(ctx: FlowContext, current: StepId): StepId | null {
  return stepsFor(ctx).find((id) => ORDER[id] > ORDER[current]) ?? null;
}

/**
 * The step Back returns to, or null for none. Never into Terms once accepted, never across a
 * confirmed birth date (the profile step), never out of the block.
 */
export function previousStep(ctx: FlowContext, current: StepId): StepId | null {
  if (GATE_STEPS.has(current)) return null;
  const earlier = stepsFor(ctx).filter((id) => ORDER[id] < ORDER[current]);
  const candidate = earlier.at(-1);
  return candidate === undefined || GATE_STEPS.has(candidate) ? null : candidate;
}

/**
 * Where a driver re-enters the flow. Terms, the profile and the block come before any saved step;
 * otherwise the saved step, or — when the flow no longer has it — the next step it does have.
 * Always a step of `stepsFor(ctx)`.
 */
export function resumeStep(ctx: FlowContext, saved: StepId | null): StepId {
  const steps = stepsFor(ctx);
  const first = steps[0] ?? 'ready';
  if (saved === null || GATE_STEPS.has(first)) return first;
  return steps.find((id) => ORDER[id] >= ORDER[saved]) ?? steps.at(-1) ?? first;
}

/**
 * The steps counted for "Step n of total": the flow as the context has it now, `current`, and the
 * steps already passed this session — kept even after the context drops them, so the count never
 * runs backwards when Terms are accepted or the profile is saved. A step that was only ahead is
 * dropped with the context (auto-detect turned off mid-walk leaves the count).
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

/**
 * The stepper route for a step. Cast like `driveHref`: the typed-routes union is generated by the
 * dev server and lags a new dynamic route.
 */
export function onboardingHref(step: StepParam): Href {
  return `/(onboarding)/${step}` as Href;
}
