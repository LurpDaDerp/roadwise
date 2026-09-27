/**
 * The number the SOS button dials. Only the two numbers every GSM/LTE handset treats as an
 * emergency call wherever it is (3GPP): 911 in the North American numbering plan, 112 elsewhere.
 * The locale is only a hint (a UK-English phone may be in the US), which is why no local number
 * such as 999 or 000 is ever chosen: the universal ones reach emergency services either way.
 */

export const DEFAULT_EMERGENCY_NUMBER = '911';

/** Regions where 911 is the local number; everywhere else gets 112. */
const NINE_ONE_ONE: ReadonlySet<string> = new Set([
  'US', 'CA', 'MX', 'PR', 'VI', 'GU', 'AS', 'MP', 'PH', 'CR', 'PA', 'DO', 'UY', 'PY', 'BO',
  'GT', 'HN', 'SV', 'NI',
]);

/**
 * The region subtag of a BCP 47 tag ("en-US" → "US", "zh-Hant-TW" → "TW", "es-419" → "419"), or
 * null when the tag names none.
 */
export function regionOfLocale(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const parts = tag.split(/[-_]/).slice(1);
  for (const part of parts) {
    if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
    if (/^\d{3}$/.test(part)) return part;
  }
  return null;
}

/** 911 for a North American region or an unknown one, 112 for any other. */
export function emergencyNumberFor(region: string | null | undefined): string {
  if (!region) return DEFAULT_EMERGENCY_NUMBER;
  return NINE_ONE_ONE.has(region.toUpperCase()) ? '911' : '112';
}

/** The device's region as `Intl` reports its default locale; null when it reports none. */
export function deviceRegion(): string | null {
  try {
    return regionOfLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

export function deviceEmergencyNumber(): string {
  return emergencyNumberFor(deviceRegion());
}

/** The dialer URL for a number: the phone app opens with it filled in, and the driver confirms. */
export function emergencyTelUrl(number: string): string {
  return `tel:${number}`;
}
