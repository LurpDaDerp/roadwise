import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance } from 'react-native';

import { useNavigationBarInk } from '../systemBars';
import { useTheme } from '../theme';

/**
 * The parts of the screen RoadWise does not draw follow the theme's scheme rather than the
 * phone's: the status bar's ink, Android's navigation bar buttons (`../systemBars`: the foot of
 * every screen is the page ground or the tab bar on it), and (through the app-wide appearance
 * override) the keyboard, alerts, pickers and maps. Under Settings › Appearance › System (`followSystem`) the override is
 * handed back to the phone, so its own Light / Dark setting rules and the theme follows it live.
 * Rendered once, inside the root ThemeProvider.
 */
export function SkyChrome({ followSystem = false }: { followSystem?: boolean }) {
  const { scheme } = useTheme();
  useNavigationBarInk(scheme === 'dark' ? 'light' : 'dark');
  useEffect(() => {
    try {
      Appearance.setColorScheme?.(followSystem ? 'unspecified' : scheme);
    } catch {
      // An older runtime without the override: the system scheme stays.
    }
  }, [scheme, followSystem]);
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} animated />;
}
