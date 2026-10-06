// The trip-actions request contract (plan §4): dispute one event, or mark the latest drive as
// "wasn't driving". Ids are the device's client ids; the user comes from the JWT alone.
import { z } from 'zod';

/** The reason sheet; `not_driving` routes to the whole-drive action. */
export const DISPUTE_REASONS = ['hazard', 'wrong_limit', 'mounted', 'not_driving'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DisputeActionSchema = z
  .object({ action: z.literal('dispute'), clientTripId: z.uuid(), eventId: z.uuid(), reason: z.enum(DISPUTE_REASONS) })
  .strict();

export const NotDrivingActionSchema = z.object({ action: z.literal('not_driving'), clientTripId: z.uuid() }).strict();

export const TripActionSchema = z.discriminatedUnion('action', [DisputeActionSchema, NotDrivingActionSchema]);
export type TripAction = z.infer<typeof TripActionSchema>;

/** What `not_driving` answers (private.revert_latest_not_driving). */
export const NotDrivingResultSchema = z.object({
  tripId: z.uuid(),
  clientTripId: z.uuid(),
  notDrivingLeft: z.number().int().min(0),
  progress: z.object({
    points: z.number().int(),
    lifetime: z.number().int().min(0),
    level: z.number().int().min(1).max(50),
    streak: z.number().int().min(0),
    atRisk: z.boolean(),
    freezes: z.number().int().min(0).max(3),
    safetyRating: z.number().nullable(),
    ranked: z.boolean(),
  }),
});

/** What `dispute` answers (private.apply_dispute). */
export const DisputeResultSchema = z.object({
  tripId: z.uuid(),
  eventId: z.uuid(),
  status: z.enum(['accepted', 'rejected']),
  rejectReason: z.enum(['quota', 'not_mounted']).nullable(),
  /** Hazard / wrong-limit auto-accepts left this week, counted under the lock after this dispute. */
  quotaLeft: z.number().int().min(0),
  net: z.number().int(),
  delta: z.number().int(),
  progress: z.object({
    points: z.number().int(),
    lifetime: z.number().int().min(0),
    level: z.number().int().min(1).max(50),
    levelUp: z.boolean(),
    safetyRating: z.number().nullable(),
    ranked: z.boolean(),
  }),
});
