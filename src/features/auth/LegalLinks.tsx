import * as WebBrowser from 'expo-web-browser';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import type { LegalDocument, LegalState } from './legal';

export const legalLinksCopy = {
  terms: 'Terms',
  privacy: 'Privacy Policy',
  opens: 'Opens in your browser',
} as const;

const openInBrowser = (url: string): Promise<unknown> => WebBrowser.openBrowserAsync(url);

/**
 * Links to the legal documents the server has published, and only those: a document with no URL
 * gets no link, and with neither there is nothing to render (ruling I7 — never point at a page
 * that does not exist). Each opens in the in-app browser, so the driver comes straight back.
 */
export function LegalLinks({
  legal,
  open = openInBrowser,
}: {
  legal: LegalState;
  /** Injectable for tests; defaults to the in-app browser. */
  open?: (url: string) => Promise<unknown>;
}) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);

  const links: { label: string; doc: LegalDocument }[] = [];
  if (legal.tos) links.push({ label: legalLinksCopy.terms, doc: legal.tos });
  if (legal.privacy) links.push({ label: legalLinksCopy.privacy, doc: legal.privacy });
  if (links.length === 0) return null;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: th.space.lg }}>
      {links.map(({ label, doc }) => (
        <Pressable
          key={label}
          accessibilityRole="link"
          accessibilityLabel={label}
          accessibilityHint={legalLinksCopy.opens}
          onPress={() => {
            // A phone with no browser to hand is not a crash; the link simply does nothing.
            open(doc.url).catch(() => {});
          }}
          style={({ pressed }) => ({
            minHeight: 44 * scale,
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text variant="subhead" tone="accent" style={{ textDecorationLine: 'underline' }}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
