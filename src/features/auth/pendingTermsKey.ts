/**
 * Where the sign-in attestation waits for its account (`pendingConsent.ts`). A module of its own so
 * the device's handover wipe (`src/boot/device.ts`) can keep the incoming driver's tick without
 * loading the Supabase client.
 */
export const PENDING_TERMS_KEY = 'auth.pendingTerms';
