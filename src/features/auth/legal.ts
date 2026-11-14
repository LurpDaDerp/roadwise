/**
 * What the driver agrees to at sign-in: "I'm 13 or older and agree to the Terms and Privacy
 * Policy". The attestation is recorded on the account against `TERMS_VERSION` (`accept_terms`).
 * Both documents are bundled with the app (`@/features/legal/documents`) and open in it.
 */

/**
 * The Terms and Privacy Policy version the sign-in checkbox agrees to: the newer of the two
 * documents' "Last updated" dates (`src/features/legal/__tests__/documents.test.ts` holds it so).
 * Bump it with the text.
 */
export const TERMS_VERSION = '2026-11-13';

/** A short safety line for the how-it-works copy. */
export const SAFETY_DISCLAIMER = 'RoadWise is a coaching aid and may miss or misreport events';
