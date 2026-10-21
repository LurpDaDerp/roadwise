// The trip-actions contract: report one event, or mark a drive as "Wasn't driving". Ids are the
// device's client ids; the user comes from the JWT alone. The shapes live in the shared upload
// contract (`_shared/payload.ts`), so the phone and the server read one definition.
export {
  DISPUTE_REASONS,
  DisputeActionSchema,
  DisputeResultSchema,
  NotDrivingActionSchema,
  NotDrivingResultSchema,
  TripActionSchema,
  type DisputeReason,
  type DisputeResult,
  type NotDrivingResult,
  type TripAction,
} from '../_shared/payload.ts';
