import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { legalState, SAFETY_DISCLAIMER } from '@/features/auth/legal';
import { LegalLinks } from '@/features/auth/LegalLinks';
import { TripTopBar } from '@/features/trips/TopBar';
import { Card, Screen, Text, useTheme } from '@/ui';

import { settingsCopy } from './copy';
import { FieldLabel, LinkRow, Section } from './parts';
import { SETTINGS_HREFS } from './routes';

const copy = settingsCopy.help;

/**
 * H11 + H12, lean: a short static FAQ, the scoring explainer, the Terms and Privacy Policy the
 * server has published (never a link to a page that does not exist, ruling I7), and the safety
 * disclaimer word for word as it was acknowledged at sign-in.
 */
export function HelpScreen({ open }: { open?: (url: string) => Promise<unknown> }) {
  const th = useTheme();
  const router = useRouter();
  const { config } = useAppConfig();
  const legal = useMemo(() => legalState(config), [config]);
  const back = router.canGoBack() ? () => router.back() : null;
  const hasDocs = legal.tos !== null || legal.privacy !== null;

  return (
    <Screen scroll testID="help-screen">
      <TripTopBar title={copy.title} onBack={back} />

      <View style={{ gap: th.space.sm }}>
        <FieldLabel>{copy.faqLabel}</FieldLabel>
        <Card padded={false} testID="help-faq">
          {copy.faq.map((item, i) => (
            <View
              key={item.q}
              accessible
              accessibilityLabel={`${item.q}. ${item.a}`}
              style={{
                padding: th.space.lg,
                gap: th.space.xs,
                borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: th.colors.divider,
              }}
            >
              <Text variant="headline">{item.q}</Text>
              <Text variant="body" tone="muted">
                {item.a}
              </Text>
            </View>
          ))}
        </Card>
      </View>

      <Section>
        <LinkRow
          testID="help-scoring"
          icon="calculator-outline"
          title={copy.scoring}
          hint={copy.scoringHint}
          onPress={() => router.push(SETTINGS_HREFS.scoring)}
        />
      </Section>

      <View style={{ gap: th.space.sm }}>
        <FieldLabel>{copy.legalLabel}</FieldLabel>
        {hasDocs ? (
          <LegalLinks legal={legal} open={open} />
        ) : (
          <Text variant="footnote" tone="muted" testID="help-no-docs">
            {copy.noDocuments}
          </Text>
        )}
      </View>

      <View style={{ gap: th.space.sm }}>
        <FieldLabel>{copy.safetyLabel}</FieldLabel>
        <Card testID="help-safety">
          <Text variant="headline">{SAFETY_DISCLAIMER}.</Text>
          <Text variant="body" tone="muted">
            {copy.safetyNote}
          </Text>
        </Card>
      </View>
    </Screen>
  );
}
