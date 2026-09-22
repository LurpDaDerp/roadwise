import type { AppConfig, BatteryGuide, OemVendor } from '@/data/config/appConfig';

/**
 * Brands that ship under another name but carry their maker's battery manager, so its guide
 * applies. Matched against `expo-device`'s `manufacturer`, lower-cased.
 */
const VENDOR_ALIASES: readonly (readonly [OemVendor, readonly string[]])[] = [
  ['samsung', ['samsung']],
  ['xiaomi', ['xiaomi', 'redmi', 'poco']],
  ['oneplus', ['oneplus']],
  ['google', ['google']],
];

/** The vendor whose guide fits this phone's maker, or null for any other (or an unknown) maker. */
export function vendorOf(manufacturer: string | null | undefined): OemVendor | null {
  const maker = (manufacturer ?? '').trim().toLowerCase();
  if (maker === '') return null;
  for (const [vendor, names] of VENDOR_ALIASES) {
    if (names.some((name) => maker.includes(name))) return vendor;
  }
  return null;
}

/**
 * The battery guide B2 prints for this phone: its maker's guide from remote config
 * (`oem_battery_guides`) when there is one, otherwise the general guide.
 */
export function guideFor(
  manufacturer: string | null | undefined,
  guides: AppConfig['oem_battery_guides']
): BatteryGuide {
  const vendor = vendorOf(manufacturer);
  return (vendor ? guides[vendor] : undefined) ?? guides.default;
}
