import { useEffect, useState } from 'react';
import { Platform, TextInput, View, useWindowDimensions, type TextInputProps } from 'react-native';

import { Text, useTheme } from '@/ui';

import { FamilyError } from './api';
import { familyCopy as copy } from './copy';

/** A caption-style label over a field, as the onboarding forms have it. */
export function FieldLabel({ children }: { children: string }) {
  return (
    <Text variant="caption" tone="muted" style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}>
      {children}
    </Text>
  );
}

/** A labelled text field in the app's form style, with its error read out when it appears. */
export function FamilyTextField({
  label,
  error,
  testID,
  ...input
}: Omit<TextInputProps, 'style'> & { label: string; error?: string | null; testID: string }) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: th.space.xs }}>
      <FieldLabel>{label}</FieldLabel>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        selectionColor={th.colors.accent}
        cursorColor={th.colors.accent}
        placeholderTextColor={th.colors.textSubtle}
        allowFontScaling={false}
        {...input}
        style={{
          minHeight: 48 * scale,
          borderWidth: 1.5,
          borderColor: error ? th.colors.danger : focused ? th.colors.accent : th.colors.borderStrong,
          borderRadius: th.radius.md,
          paddingHorizontal: th.space.md,
          backgroundColor: th.colors.surface,
          color: th.colors.text,
          fontSize: 17 * scale,
        }}
      />
      {error ? (
        <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite" testID={`${testID}-error`}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A failed family call, in words (never the server's text). */
export function errorText(error: unknown): string {
  return error instanceof FamilyError ? copy.errors[error.code] : copy.errors.unknown;
}

/**
 * Whether this build can draw a map: iOS always (Apple Maps needs no key); Android only once a Google
 * Maps key is configured (`EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY`, the same value app.config.ts gives
 * the native module), so the map switches on with the key and no code change.
 */
export function mapAvailable(
  platform: string = Platform.OS,
  androidKey: string | undefined = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY
): boolean {
  if (platform === 'ios') return true;
  return platform === 'android' && typeof androidKey === 'string' && androidKey.trim() !== '';
}

// ---------------------------------------------------------------------------------------------
// The coarse area a location is in, from the phone's own reverse geocoding
// ---------------------------------------------------------------------------------------------

export type ReverseGeocode = (point: { latitude: number; longitude: number }) => Promise<
  readonly { district?: string | null; subregion?: string | null; city?: string | null }[]
>;

function expoReverseGeocode(): ReverseGeocode {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a native module, only when used
  const Location = require('expo-location') as typeof import('expo-location');
  return (point) => Location.reverseGeocodeAsync(point);
}

/** Areas already named, keyed on a ~1 km grid: coarse on purpose, and one lookup per cell. */
const areas = new Map<string, string | null>();

/** Test seam. */
export function resetAreaCache(): void {
  areas.clear();
}

const cell = (lat: number, lng: number) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

/** The neighbourhood or town a location is in, or null (not found yet, or not at all). */
export function useArea(
  location: { lat: number; lng: number } | null,
  reverse: ReverseGeocode | null = null
): string | null {
  const key = location === null ? null : cell(location.lat, location.lng);
  // A name found by this hook, for the cell it was found for; the shared cache answers the rest.
  const [found, setFound] = useState<{ key: string; name: string | null } | null>(null);
  const lat = location?.lat;
  const lng = location?.lng;
  useEffect(() => {
    if (key === null || lat === undefined || lng === undefined || areas.has(key)) return;
    let live = true;
    const lookup = reverse ?? safeExpoReverse();
    if (lookup === null) return;
    void lookup({ latitude: lat, longitude: lng })
      .then((results) => {
        const first = results[0];
        const name = first?.district?.trim() || first?.subregion?.trim() || first?.city?.trim() || null;
        areas.set(key, name);
        if (live) setFound({ key, name });
      })
      .catch(() => {
        // No name: the line says "Location shared" instead.
      });
    return () => {
      live = false;
    };
    // The point is read through `key`: a move within the same cell needs no second lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reverse]);
  if (key === null) return null;
  if (areas.has(key)) return areas.get(key) ?? null;
  return found?.key === key ? found.name : null;
}

function safeExpoReverse(): ReverseGeocode | null {
  try {
    return expoReverseGeocode();
  } catch {
    return null;
  }
}
