import { Ionicons } from '@expo/vector-icons';
import { AUTO_TRIGGER } from '@drive-sense/detect/policy';
import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { HERO, rules, type DriveNumbers, type RuleSection } from '@/content/howScores';
import { NOT_DRIVING_BUDGET_MS } from '@/drive/notDriving';
import { WAIT_TOTAL_MS } from '@/drive/waiting';
import { autoDrivesOn, useAutoDrives } from '@/features/autoDrives/useAutoDrives';
import { BackHeader } from '@/features/drives/BackHeader';
import { HOME_HREF } from '@/features/drives/routes';
import { Card, Screen, Text, useTheme } from '@/ui';

import { HowItWorksList } from './HowItWorksList';

/** The drive rules the page quotes, from the drive code itself. */
export const DRIVE_NUMBERS: DriveNumbers = {
  autoMinMph: AUTO_TRIGGER.minMph,
  autoMaxHoldS: AUTO_TRIGGER.maxHoldS,
  autoStepS: AUTO_TRIGGER.stepS,
  autoStepMph: AUTO_TRIGGER.stepMph,
  autoInstantMph: AUTO_TRIGGER.instantMph,
  waitMin: WAIT_TOTAL_MS / 60_000,
  notDrivingMin: NOT_DRIVING_BUDGET_MS / 60_000,
};

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
        {section.lines.map((p) => (
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

/** How scores work: the three big ideas, then every rule in plain words, worded for how drives start on this phone. */
export function HowScoresView({ onBack, autoDrives }: { onBack: () => void; autoDrives: boolean }) {
  const t = useTheme();
  return (
    <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.xl }} testID="how-scores-work">
      <BackHeader title="How scores work" onBack={onBack} />

      <Card variant="hero" testID="how-scores-hero">
        <Text variant="title2">{HERO.title}</Text>
        <Text variant="body">{HERO.body}</Text>
      </Card>

      <HowItWorksList autoDrives={autoDrives} />

      {rules(autoDrives, DRIVE_NUMBERS).map((s) => (
        <Section key={s.id} section={s} />
      ))}
    </ScrollView>
  );
}

export function HowScoresScreen() {
  const router = useRouter();
  const auto = useAutoDrives();
  return (
    <Screen padded={false}>
      <HowScoresView autoDrives={autoDrivesOn(auto)} onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME_HREF))} />
    </Screen>
  );
}
