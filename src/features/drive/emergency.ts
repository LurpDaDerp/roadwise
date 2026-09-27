/**
 * The number the SOS button dials: the region's single emergency number, from the device's
 * locale. 911 by default — it and 112 are the two numbers handsets and networks route to
 * emergency services almost everywhere, whatever the local number is. A tiny table, not a
 * gazetteer: only regions whose number is one of the well-known few.
 */

export const DEFAULT_EMERGENCY_NUMBER = '911';

const BY_NUMBER: Record<string, readonly string[]> = {
  // The EU/EEA single number and the countries that share it.
  '112': [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE',
    'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'CH', 'TR', 'UA', 'RS', 'ME', 'MK', 'BA', 'AL', 'MD', 'GE', 'RU', 'KZ', 'IN', 'ZA', 'IL',
    'KR', 'BR', 'AR', 'CL', 'CO', 'PE', 'EC', 'VN',
  ],
  '999': ['GB', 'HK', 'MY', 'SG', 'KE', 'BD', 'QA', 'BH', 'KW', 'AE', 'ZW', 'MU', 'TT', 'JM'],
  '000': ['AU'],
  '111': ['NZ'],
  '911': ['US', 'CA', 'MX', 'PH', 'CR', 'PA', 'DO', 'UY', 'PY', 'BO', 'GT', 'HN', 'SV', 'NI'],
};

const BY_REGION: ReadonlyMap<string, string> = new Map(
  Object.entries(BY_NUMBER).flatMap(([number, regions]) => regions.map((r) => [r, number]))
);

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

/** The emergency number for a region code; the default for an unknown or unlisted one. */
export function emergencyNumberFor(region: string | null | undefined): string {
  if (!region) return DEFAULT_EMERGENCY_NUMBER;
  return BY_REGION.get(region.toUpperCase()) ?? DEFAULT_EMERGENCY_NUMBER;
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
