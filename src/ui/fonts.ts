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

/** Loads the licence faces. Returns true once they are ready to draw with. */
export function useAppFonts(): boolean {
  const [loaded] = useFonts({
    B612_400Regular,
    B612_700Bold,
    B612Mono_400Regular,
    B612Mono_700Bold,
  });
  return loaded;
}
