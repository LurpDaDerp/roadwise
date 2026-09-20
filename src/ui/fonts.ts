import { B612_400Regular, B612_700Bold } from '@expo-google-fonts/b612';
import { B612Mono_400Regular, B612Mono_700Bold } from '@expo-google-fonts/b612-mono';
import { useFonts } from 'expo-font';
import { Platform } from 'react-native';

/**
 * The licence card's faces. B612 was drawn for aircraft cockpit displays, so it carries the
 * printed-document voice the direction asks for and stays legible at a glance; B612 Mono gives
 * the HUD and every field numeral a fixed advance width. UI chrome stays on the platform face.
 */
export const fontFamilies: {
  ui: string;
  field: string;
  fieldBold: string;
  numerals: string;
  numeralsBold: string;
} = {
  ui: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }) ?? 'System',
  field: 'B612_400Regular',
  fieldBold: 'B612_700Bold',
  numerals: 'B612Mono_400Regular',
  numeralsBold: 'B612Mono_700Bold',
};

export type AppFontsState = { loaded: boolean; error: Error | null };

/**
 * Loads the licence faces. The error is reported, not swallowed: a face that fails to download or
 * decode has to be a recoverable condition, or the app sits on the splash screen forever.
 */
export function useAppFonts(): AppFontsState {
  const [loaded, error] = useFonts({
    B612_400Regular,
    B612_700Bold,
    B612Mono_400Regular,
    B612Mono_700Bold,
  });
  return { loaded, error };
}

/**
 * Whether the app may draw its first frame. Holding the splash for the licence faces is worth one
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
