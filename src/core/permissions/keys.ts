// Settings keys for permission state (device-local, emptied by the existing account wipe).
// There is deliberately no auto-record on/off key: the drive host owns that (`setAutoDetect`).

/** `PromptHistory`: the last OS prompt per permission, for the 14-day rule (policy.ts). */
export const PROMPTS_KEY = 'permissions.prompts';

/** The one-shot post-drive Always offers already made (Task 9's prompts host). */
export const ALWAYS_OFFER_KEY = 'permissions.alwaysOffer';

/** The driver tapped Continue on the background-location prominent disclosure. */
export const DISCLOSURE_AFFIRMED_KEY = 'permissions.disclosureAffirmed';

/** Manual mode by the driver's choice (A9 Skip, Always declined): never nagged about. */
export const MANUAL_BY_CHOICE_KEY = 'permissions.manualByChoice';

/** `EverGranted`: which permissions have ever been granted on this install (lapse detection). */
export const EVER_GRANTED_KEY = 'permissions.everGranted';

/**
 * The driver wants auto-record once Always is granted. Not an auto-detect setting — the host
 * owns that; this only says to call `host.setAutoDetect(true)` when Always arrives.
 */
export const AUTO_RECORD_INTENT_KEY = 'permissions.autoRecordIntent';
