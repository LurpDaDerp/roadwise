// The trip-actions request contract: one of three actions, each strict. Ids are the device's
// client ids (the server ids never leave the database); the user comes from the JWT alone.
import { z } from 'zod';
import { CLIENT_ID_PATTERN } from '../_shared/plausibility.ts';

/** The D3 reason sheet, as `event_disputes.reason` stores it. */
export const DISPUTE_REASONS = ['not_driver', 'passenger_phone', 'wrong_limit', 'hazard', 'phone_moved', 'other'] as const;
/** The roles a user may state for a trip (D5); `unknown` is the engine's, not the user's. */
export const STATED_ROLES = ['driver', 'passenger', 'other'] as const;
export const MAX_NOTE_CHARS = 500;

/**
 * A note is free text the owner, ops and the tuning pipeline read back. Control characters (a
 * newline excepted) and format characters — bidi overrides, zero-width joiners and spaces,
 * byte-order marks — are stripped before the length is checked, so what is stored renders as
 * what was typed and the bound applies to what is stored.
 */
export const cleanNote = (note: string): string => note.replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, '');

/** Mirrors `trips.client_trip_id`: the id is also the storage key's second segment. */
const clientTripId = z.string().regex(CLIENT_ID_PATTERN, 'clientTripId must be 1 to 64 url-safe characters');
/** Mirrors `trip_events.client_event_id` (length only; the table has no character class). */
const clientEventId = z.string().min(1).max(64);

export const DisputeActionSchema = z
  .object({
    action: z.literal('dispute'),
    clientEventId,
    reason: z.enum(DISPUTE_REASONS),
    note: z.string().transform(cleanNote).pipe(z.string().max(MAX_NOTE_CHARS)).nullable().optional(),
    /** The posted limit the driver states for a wrong-limit dispute; 5..100 as the table bounds it. */
    statedLimitMph: z.number().int().min(5).max(100).nullable().optional(),
  })
  .strict();

export const SetRoleActionSchema = z
  .object({
    action: z.literal('set-role'),
    clientTripId,
    role: z.enum(STATED_ROLES),
  })
  .strict();

export const DeleteActionSchema = z
  .object({
    action: z.literal('delete'),
    clientTripId,
  })
  .strict();

export const TripActionSchema = z.discriminatedUnion('action', [
  DisputeActionSchema,
  SetRoleActionSchema,
  DeleteActionSchema,
]);

export type DisputeAction = z.infer<typeof DisputeActionSchema>;
export type SetRoleAction = z.infer<typeof SetRoleActionSchema>;
export type DeleteAction = z.infer<typeof DeleteActionSchema>;
export type TripAction = z.infer<typeof TripActionSchema>;
