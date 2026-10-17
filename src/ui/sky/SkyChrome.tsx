import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance } from 'react-native';

import { useTheme } from '../theme';

/**
 * The parts of the screen RoadWise does not draw follow the sky's scheme rather than the phone's:
 * the status bar's ink, and (through the app-wide appearance override) the keyboard, alerts,
 * pickers and maps. Rendered once, inside the root ThemeProvider.
 */
export function SkyChrome() {
  const { scheme } = useTheme();
  useEffect(() => {
    try {
      Appearance.setColorScheme?.(scheme);
    } catch {
      // An older runtime without the override: the system scheme stays.
    }
  }, [scheme]);
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} animated />;
}
