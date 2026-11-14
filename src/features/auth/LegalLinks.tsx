import { useRouter, type Href } from 'expo-router';
import { Pressable, useWindowDimensions, View } from 'react-native';

import type { LegalDocKey } from '@/features/legal/documents';
import { Text, useTheme } from '@/ui';

export const legalLinksCopy = {
  terms: 'Terms',
  privacy: 'Privacy Policy',
  opens: 'Opens the full text',
} as const;

/** The in-app reading screen of each document (`app/legal/[doc].tsx`). */
export const LEGAL_HREFS: Record<LegalDocKey, Href> = {
  terms: '/legal/terms' as Href,
  privacy: '/legal/privacy' as Href,
};

const LINKS: { label: string; doc: LegalDocKey }[] = [
  { label: legalLinksCopy.terms, doc: 'terms' },
  { label: legalLinksCopy.privacy, doc: 'privacy' },
];

/**
 * Links to the Terms of Service and the Privacy Policy, on the sign-in screen and at the foot of
 * Settings. Each opens the document in the app (bundled with the build, so it reads offline and
 * before sign-in); Back returns here.
 */
export function LegalLinks({
  navigate,
}: {
  /** Injectable for tests; defaults to pushing the reading screen. */
  navigate?: (href: Href) => void;
}) {
  const th = useTheme();
  const router = useRouter();
  const go = navigate ?? ((href: Href) => router.push(href));
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: th.space.lg }}>
      {LINKS.map(({ label, doc }) => (
        <Pressable
          key={doc}
          accessibilityRole="link"
          accessibilityLabel={label}
          accessibilityHint={legalLinksCopy.opens}
          onPress={() => go(LEGAL_HREFS[doc])}
          testID={`legal-link-${doc}`}
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
