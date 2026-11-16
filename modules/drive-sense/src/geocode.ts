// The Android geocoder bridge (WP10): `reverseGeocode` and `forwardGeocode` of the Kotlin DriveSense
// module (Geocode.kt), android.location.Geocoder with no activity behind it, so a drive finalized
// with RoadWise in the background or headless still gets its labels (expo-location's Android
// geocoder pauses itself whenever the activity goes behind). iPhone keeps expo-location's geocoder:
// these two are not in DRIVE_SENSE_METHODS and the iOS module has neither.
//
// The answers are expo-location's shapes (`LocationGeocodedAddress`, `LocationGeocodedLocation`),
// checked here, so the app's callers read both platforms the same way. Null means no answer at all:
// the phone has no geocoder (Geocoder.isPresent() false), the lookup failed or timed out natively.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { z } from 'zod';

/** The Android-only geocoder functions of the DriveSense module (`AsyncFunction` in DriveSenseModule.kt). */
export const ANDROID_GEOCODE_METHODS = ['reverseGeocode', 'forwardGeocode'] as const;

/** The longest typed address forwarded (Geocode.kt MAX_QUERY_CHARS). */
export const GEOCODE_QUERY_MAX = 200;

const part = z.string().nullable().optional();

/** One address, expo-location's `LocationGeocodedAddress` keys (Android fills no `timezone` or `formattedAddress`). */
export const nativeAddressSchema = z.object({
  city: part,
  district: part,
  streetNumber: part,
  street: part,
  region: part,
  subregion: part,
  country: part,
  postalCode: part,
  name: part,
  isoCountryCode: part,
});

export type NativeAddress = z.infer<typeof nativeAddressSchema>;

const nativePointSchema = z.object({ latitude: z.number().finite(), longitude: z.number().finite() });

export type NativePoint = z.infer<typeof nativePointSchema>;

/** The native geocoder, when this build has it (an Android build with WP10); null elsewhere. */
export interface NativeGeocoder {
  /** The addresses at a point; null with no answer (no geocoder, a failure, a timeout). Never rejects. */
  reverse(lat: number, lng: number): Promise<NativeAddress[] | null>;
  /** The points a typed address names; null with no answer. Never rejects. */
  forward(query: string): Promise<NativePoint[] | null>;
}

type GeocodeModule = {
  reverseGeocode?: (lat: number, lng: number) => Promise<unknown>;
  forwardGeocode?: (query: string) => Promise<unknown>;
};

let moduleForTests: GeocodeModule | null | undefined;

/** Tests: stand in for the native module (null: none); undefined goes back to the real lookup. */
export function setGeocodeModuleForTests(m: GeocodeModule | null | undefined): void {
  moduleForTests = m;
}

const lookup = (): GeocodeModule | null => (moduleForTests !== undefined ? moduleForTests : (requireOptionalNativeModule<GeocodeModule>('DriveSense') ?? null));

/** An answer as a checked list; anything malformed is no answer. */
async function settle<T>(p: Promise<unknown>, item: z.ZodType<T>): Promise<T[] | null> {
  try {
    const raw = await p;
    if (raw === null || raw === undefined) return null;
    const parsed = z.array(item).safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The native geocoder, or null where the build has none (iOS, Jest, Expo Go, an Android build made
 * before it): the caller then uses expo-location as before.
 */
export function nativeGeocoder(): NativeGeocoder | null {
  const m = lookup();
  if (!m || typeof m.reverseGeocode !== 'function' || typeof m.forwardGeocode !== 'function') return null;
  const reverseFn = m.reverseGeocode.bind(m);
  const forwardFn = m.forwardGeocode.bind(m);
  return {
    reverse: (lat, lng) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return Promise.resolve(null);
      return settle(Promise.resolve().then(() => reverseFn(lat, lng)), nativeAddressSchema);
    },
    forward: (query) => {
      const q = typeof query === 'string' ? query.trim() : '';
      if (q.length === 0 || q.length > GEOCODE_QUERY_MAX) return Promise.resolve(null);
      return settle(Promise.resolve().then(() => forwardFn(q)), nativePointSchema);
    },
  };
}
