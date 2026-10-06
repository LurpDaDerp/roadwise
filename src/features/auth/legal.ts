/**
 * What the driver agrees to at sign-in: "I'm 13 or older and agree to the Terms and Privacy
 * Policy". The attestation is recorded on the account against `TERMS_VERSION` (`accept_terms`).
 * The documents' links come from the server (`app_config.legal_urls`); a document with no URL gets
 * no link.
 */

/** The Terms and Privacy Policy version the sign-in checkbox agrees to. Bump when either changes. */
export const TERMS_VERSION = '2026-10-05';

/** A short safety line for the how-it-works copy. */
export const SAFETY_DISCLAIMER = 'RoadWise is a coaching aid and may miss or misreport events';

/** The slice of the app config this reads. Anything else, or anything of the wrong type, is ignored. */
export interface LegalConfig {
  onboarding?: { tos_version?: string; privacy_version?: string };
  legal_urls?: { terms?: string; privacy?: string };
}

export interface LegalDocument {
  version: string;
  url: string;
}

export interface LegalState {
  /** Both documents can be opened and carry a version: only then are they offered for acceptance. */
  published: boolean;
  tos: LegalDocument | null;
  privacy: LegalDocument | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Only a web address can be opened by the in-app browser; a relative path or a script URL cannot. */
const webUrl = (v: unknown): string | null => {
  const s = text(v);
  return s !== null && /^https?:\/\/[^\s/]+\S*$/i.test(s) ? s : null;
};

const pair = (version: unknown, url: unknown): LegalDocument | null => {
  const v = text(version);
  const u = webUrl(url);
  return v !== null && u !== null ? { version: v, url: u } : null;
};

export function legalState(config: LegalConfig | null | undefined): LegalState {
  const onboarding = isRecord(config) && isRecord(config.onboarding) ? config.onboarding : {};
  const urls = isRecord(config) && isRecord(config.legal_urls) ? config.legal_urls : {};
  const tos = pair(onboarding.tos_version, urls.terms);
  const privacy = pair(onboarding.privacy_version, urls.privacy);
  return { published: tos !== null && privacy !== null, tos, privacy };
}
