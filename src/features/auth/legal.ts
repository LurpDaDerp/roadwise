/**
 * What the driver is asked to agree to, and whether there is anything to agree to yet.
 *
 * The safety disclaimer ships with the app, so it can always be acknowledged. The Terms and the
 * Privacy Policy exist only once the server publishes a URL for each (`app_config.legal_urls`),
 * and a consent is recorded against a version (`app_config.onboarding`). Until both documents can
 * be opened, nobody is asked to accept them and no `tos`/`privacy` consent is recorded (ruling I7):
 * a consent to a document nobody can read is not one.
 */

/** Product spec §7.A A3, word for word. Wording flagged for counsel before any store-bound build. */
export const SAFETY_DISCLAIMER = 'RoadWise is a coaching aid and may miss or misreport events';

/** Bump when `SAFETY_DISCLAIMER` changes, so everyone acknowledges the new wording. */
export const DISCLAIMER_VERSION = '2026-09-21';

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
