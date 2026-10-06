import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { HOW_IT_WORKS, PENALTIES, RULES, type RuleSection } from '@/content/howPoints';
import { useUnits } from '@/data/queries/units';
import { BackHeader } from '@/features/drives/BackHeader';
import { HOME_HREF } from '@/features/drives/routes';
import { Card, Divider, Screen, Text, useTheme } from '@/ui';

/** The three big ideas, as on the onboarding step. Also used by Home's first-run card. */
export function HowItWorksList() {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.md }}>
      {HOW_IT_WORKS.map((item) => (
        <View key={item.title} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' }} accessible accessibilityLabel={`${item.title}. ${item.body}`}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: t.colors.accentFaint,
            }}
          >
            <Ionicons name={item.icon} size={t.size.icon} color={t.colors.accent} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{item.title}</Text>
            <Text variant="subhead" tone="muted">
              {item.body}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function Section({ section }: { section: RuleSection }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }} testID={`rules-${section.id}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Ionicons name={section.icon} size={t.size.icon} color={t.colors.accent} />
        <Text variant="title3" accessibilityRole="header">
          {section.title}
        </Text>
      </View>
      <Card>
        {section.points.map((p) => (
          <View key={p} style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Text variant="body" tone="subtle" importantForAccessibility="no" accessibilityElementsHidden>
              •
            </Text>
            <Text variant="body" style={{ flex: 1 }}>
              {p}
            </Text>
          </View>
        ))}
      </Card>
    </View>
  );
}

/** How points work: the explainer from onboarding, then every rule in plain words. */
export function HowPointsView({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const units = useUnits();
  const [first, ...rest] = RULES;
  return (
    <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.xl }} testID="how-points-work">
      <BackHeader title="How points work" onBack={onBack} />

      <Card variant="hero">
        <Text variant="title2">Drive safe. Earn points. Keep the streak.</Text>
        <View accessible accessibilityLabel="Drive points equal safe miles times 10 times your multiplier, minus penalties">
          <Text variant="stat" style={{ color: t.colors.gold }}>
            safe mi × 10 × multiplier
          </Text>
          <Text variant="stat" style={{ color: t.colors.signal.severe.text }}>
            − penalties
          </Text>
        </View>
        {units === 'km' ? (
          <Text variant="footnote" tone="muted" testID="how-points-miles-note">
            Points are counted per mile, so the rules below use miles (1 mi = 1.6 km).
          </Text>
        ) : null}
      </Card>

      <HowItWorksList />

      {first ? <Section section={first} /> : null}

      <View style={{ gap: t.space.sm }} testID="rules-penalties">
        <Text variant="title3" accessibilityRole="header">
          What events cost
        </Text>
        <Card padded={false}>
          {PENALTIES.map((row, i) => (
            <View key={row.event}>
              {i > 0 ? <Divider inset={16} /> : null}
              <View accessible style={{ padding: t.space.lg, gap: 2 }}>
                <Text variant="headline">{row.event}</Text>
                <Text variant="subhead" tone="muted">
                  {row.penalty}
                </Text>
              </View>
            </View>
          ))}
        </Card>
      </View>

      {rest.map((s) => (
        <Section key={s.id} section={s} />
      ))}
    </ScrollView>
  );
}

export function HowPointsScreen() {
  const router = useRouter();
  return (
    <Screen padded={false}>
      <HowPointsView onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME_HREF))} />
    </Screen>
  );
}
