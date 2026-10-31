import { BarlowSemiCondensed_600SemiBold } from '@expo-google-fonts/barlow-semi-condensed/600SemiBold';
import { BarlowSemiCondensed_700Bold } from '@expo-google-fonts/barlow-semi-condensed/700Bold';
import { BarlowSemiCondensed_800ExtraBold } from '@expo-google-fonts/barlow-semi-condensed/800ExtraBold';
import { BarlowSemiCondensed_800ExtraBold_Italic } from '@expo-google-fonts/barlow-semi-condensed/800ExtraBold_Italic';
import { useFonts } from 'expo-font';
import { Platform } from 'react-native';

/**
 * Barlow Semi Condensed was drawn from the lettering on California highway signs, so it is a road
 * face before it is a sports face: heavy numerals that read at a glance, narrow enough that a
 * four-digit number still fits a tile at 2× Dynamic Type. It carries numbers, headlines and
 * labels; reading text and controls stay on the platform face (SF Pro / Roboto).
 *
 * Only the four weights in use are imported (per-weight subpaths), so Metro bundles four files.
 */
const FACES = {
  BarlowSemiCondensed_600SemiBold,
  BarlowSemiCondensed_700Bold,
  BarlowSemiCondensed_800ExtraBold,
  BarlowSemiCondensed_800ExtraBold_Italic,
};

type Families = {
  /** Platform UI face: body, controls. */
  ui: string;
  /** Headlines (title1–3). */
  headline: string;
  /** Numerals and display numbers. */
  display: string;
  /** The one italic: hero numbers. */
  displayItalic: string;
  /** Condensed caps labels. */
  label: string;
  /** @deprecated v2 names, kept so the HUD (src/ui/drive) and older screens compile. */
  field: string;
  /** @deprecated */
  fieldBold: string;
  /** @deprecated */
  numerals: string;
  /** @deprecated */
  numeralsBold: string;
};

export const fontFamilies: Families = {
  ui: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }) ?? 'System',
  headline: 'BarlowSemiCondensed_700Bold',
  display: 'BarlowSemiCondensed_800ExtraBold',
  displayItalic: 'BarlowSemiCondensed_800ExtraBold_Italic',
  label: 'BarlowSemiCondensed_600SemiBold',
  field: 'BarlowSemiCondensed_600SemiBold',
  fieldBold: 'BarlowSemiCondensed_700Bold',
  numerals: 'BarlowSemiCondensed_700Bold',
  numeralsBold: 'BarlowSemiCondensed_800ExtraBold',
};

export type AppFontsState = { loaded: boolean; error: Error | null };

/**
 * Loads the display faces. The error is reported, not swallowed: a face that fails to download or
 * decode has to be a recoverable condition, or the app sits on the splash screen forever.
 */
export function useAppFonts(): AppFontsState {
  const [loaded, error] = useFonts(FACES);
  return { loaded, error };
}

/**
 * Whether the app may draw its first frame. Holding the splash for the display faces is worth one
 * beat and no more: a load error, or a wait long enough to read as a hang, hands the app over to
 * the platform faces instead — every `Text` style names a family the system quietly falls back on.
 */
export function shouldRender({
  loaded,
  error,
  timedOut,
}: {
  loaded: boolean;
  error: Error | null;
  timedOut: boolean;
}): boolean {
  return loaded || error !== null || timedOut;
}

/** How long the splash may hold for the faces before the app draws with the platform ones. */
export const FONT_WAIT_MS = 3000;

/** Every face `useAppFonts` registers, for tests and the gallery. */
export const FONT_FACE_NAMES = Object.keys(FACES);
