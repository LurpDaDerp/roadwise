// DEMO ONLY (temporary): a phone pickup counts and alerts at any speed, with the car stopped or the
// drive not yet started. Off under Jest so the detector's own tests keep judging the real rule.
export const DEMO_PHONE_ANY_SPEED = process.env.NODE_ENV !== 'test';
