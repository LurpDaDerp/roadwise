import * as WebBrowser from 'expo-web-browser';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { settingsCopy } from './copy';

const copy = settingsCopy.root.credits;

export const CREDIT_URLS = {
  openMeteo: 'https://open-meteo.com',
  osm: 'https://www.openstreetmap.org/copyright',
} as const;

const openInBrowser = (url: string): Promise<unknown> => WebBrowser.openBrowserAsync(url);

/**
 * The foot of Settings: who the weather and the speed limits come from (Open-Meteo's CC BY 4.0 and
 * OpenStreetMap's ODbL ask for the credit), with links that open in the in-app browser, as the
 * sign-in screen's legal links do.
 */
export function DataCredits({
  open = openInBrowser,
}: {
  /** Injectable for tests; defaults to the in-app browser. */
  open?: (url: string) => Promise<unknown>;
}) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const links = [
    { label: copy.openMeteo, url: CREDIT_URLS.openMeteo },
    { label: copy.osm, url: CREDIT_URLS.osm },
  ];

  return (
    <View testID="settings-credits">
      <Text variant="footnote" tone="muted">
        {copy.line}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: th.space.lg }}>
        {links.map(({ label, url }) => (
          <Pressable
            key={label}
            accessibilityRole="link"
            accessibilityLabel={label}
            accessibilityHint={copy.opens}
            onPress={() => {
              // A phone with no browser to hand is not a crash; the link simply does nothing.
              open(url).catch(() => {});
            }}
            style={({ pressed }) => ({
              minHeight: 44 * scale,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="footnote" tone="accent" style={{ textDecorationLine: 'underline' }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
